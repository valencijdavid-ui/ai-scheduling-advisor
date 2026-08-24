# Runbook — Sincronizzazione Google Calendar

Cosa fare quando arriva l'email `[Ambrogio] Appuntamenti non sincronizzati con Google Calendar`.

## Il fatto da tenere presente prima di tutto

**L'appuntamento esiste ed è valido.** Postgres è la sorgente di verità per
esistenza, orario, stato e prevenzione dei doppi impegni; il vincolo di
esclusione `appointments_no_confirmed_overlap` tiene lo slot occupato
indipendentemente da Google. La dashboard (`/calendar`) legge Postgres, quindi
l'operatore vede l'appuntamento anche quando la sincronizzazione è ferma.

Quello che manca è la **copia** sul calendario Google dello studio. Il rischio
concreto è che lo studio, guardando solo Google, prenda un altro impegno sullo
stesso orario.

Non serve avvisare il cliente: quello che gli è stato detto è vero.

## Stati

| `calendar_sync_status` | `calendar_sync_next_attempt_at` | Significato |
|---|---|---|
| `not_configured` | `null` | Il tenant non ha Google collegato. Normale. |
| `pending` | valorizzato | Sincronizzazione dovuta, il cron ci arriverà. |
| `synced` | `null` | Evento allineato. |
| `failed` | valorizzato, `attempts < 5` | Fallita, altri tentativi in programma. |
| `failed` | `attempts >= 5` oppure appuntamento già passato | **Terminale.** Serve un intervento. |

La terminalità è il predicato, non la colonna nulla:

```sql
calendar_sync_status = 'failed'
and (calendar_sync_attempts >= 5 or scheduled_at <= now())
```

Backoff: 5, 10, 20, 40 minuti fra i tentativi, cinque in tutto — poco più di
un'ora dal primo fallimento alla terminalità.

## 1. Cosa è terminale adesso

```sql
select id, tenant_id, customer_name, scheduled_at,
       calendar_sync_attempts, calendar_sync_error, calendar_event_id
from public.appointments
where calendar_provider = 'google_calendar'
  and calendar_sync_status = 'failed'
  and calendar_sync_attempts >= 5
  and scheduled_at > now()
order by scheduled_at asc;
```

Leggere `calendar_sync_error`. I casi che si vedono davvero:

- **`401` / `403` / token** — il tenant ha revocato l'accesso o le credenziali
  sono scadute. Va rifatto il collegamento da *Impostazioni → Google Calendar*.
  Dopo il collegamento, riaprire le righe con la query 4.
- **`Google Calendar integration is not connected for this tenant`** — stesso
  caso, visto dal lato nostro: l'integrazione è `revoked`.
- **`Legacy appointment without calendar_event_id`** — riga precedente a questa
  migrazione, senza identità dell'evento. Il sistema **non** la riconcilia da
  solo di proposito: potrebbe esistere già un evento su Google che non
  sappiamo indirizzare, e crearne uno nuovo produrrebbe un doppione. Cercare a
  mano l'evento sul calendario del tenant; se non c'è, crearlo a mano.
- **`5xx` / rete** — guasto Google prolungato. Riaprire con la query 4.

## 2. Vista giornaliera: tutto ciò che non è allineato

```sql
select calendar_sync_status,
       count(*) filter (where scheduled_at <= now() + interval '24 hours') as entro_24h,
       count(*) as totale
from public.appointments
where calendar_provider = 'google_calendar'
  and calendar_sync_status in ('pending', 'failed')
  and scheduled_at > now()
group by calendar_sync_status;
```

## 3. Il reconciler sta girando?

```sql
select count(*) as in_ritardo
from public.appointments
where calendar_provider = 'google_calendar'
  and calendar_sync_status in ('pending', 'failed')
  and calendar_sync_next_attempt_at < now() - interval '30 minutes'
  and calendar_sync_attempts < 5
  and scheduled_at > now();
```

Se il numero è maggiore di zero, il job non gira. Verificare che il cron
Vercel stia invocando `/api/internal/jobs/calendar-sync` e che risponda 200.
Invocazione manuale:

```bash
curl -X POST https://<host>/api/internal/jobs/calendar-sync \
  -H "$INTERNAL_JOB_HEADER_NAME: $INTERNAL_JOB_SECRET"
```

## 4. Riaprire righe terminali (dopo aver rimosso la causa)

Solo dopo aver ricollegato Google o verificato che il guasto sia finito.
Azzerare i tentativi rimette la riga nel giro automatico al tick successivo.

```sql
update public.appointments
set calendar_sync_attempts = 0,
    calendar_sync_next_attempt_at = now(),
    calendar_sync_error = null
where tenant_id = '<tenant>'
  and id = '<appointment>'
  and calendar_event_id is not null;
```

`calendar_event_id is not null` non è decorativo: è la condizione che impedisce
di riaprire una riga storica priva di identità, per cui la riconciliazione
automatica potrebbe creare un evento duplicato.

Riaprire tutto un tenant dopo un ricollegamento:

```sql
update public.appointments
set calendar_sync_attempts = 0,
    calendar_sync_next_attempt_at = now(),
    calendar_sync_error = null
where tenant_id = '<tenant>'
  and calendar_provider = 'google_calendar'
  and calendar_sync_status = 'failed'
  and calendar_event_id is not null
  and scheduled_at > now();
```

## Cosa NON fare

- **Non cancellare a mano eventi su Google** per "ripulire": la convergenza
  legge prima di scrivere e riporterebbe l'evento com'era. Se un appuntamento
  va annullato, annullarlo dal prodotto.
- **Non riaprire righe con `calendar_event_id is null`** (vedi sopra).
- **Non modificare `calendar_sync_status` a `synced` a mano** per far tacere
  l'allarme: l'evento resterebbe assente e il segnale sparirebbe.
- Rinominare o spostare a mano un evento su Google è invece innocuo: la
  convergenza confronta solo stato, inizio e fine, e non riscrive il titolo.

## Gate di deploy

Prima di applicare la migrazione, contare le righe che il backfill renderà
terminali (vanno risolte a mano, una per una):

```sql
select count(*)
from public.appointments
where calendar_provider = 'google_calendar'
  and calendar_sync_status in ('pending', 'failed')
  and calendar_event_id is null
  and status in ('confirmed', 'cancelled')
  and scheduled_at > now();
```

## Fuori ambito (registrato, non risolto qui)

- **PILOT-P0-2 — lettura disponibilità.** `getAvailableSlots` interroga Google
  freeBusy senza catch, e `createAppointment` la richiama per rivalidare lo
  slot. Durante un'indisponibilità di Google la prenotazione non parte proprio,
  e l'errore risale fino al webhook: il cliente non riceve nessuna risposta.
  P0-1 non copre questo percorso e non va descritto come se lo facesse.
- **PILOT-P0-3 — cancellazione GDPR e Google.** La cancellazione Art. 17
  (`src/server/gdpr/data-delete.ts`) rimuove le righe `appointments` da
  Postgres senza eliminare i corrispondenti eventi Google, che contengono nome
  del cliente nel titolo e telefono in `extendedProperties`. Dopo una
  cancellazione quei dati restano sul calendario del tenant. Va risolto
  separatamente, prima del pilota se il pilota tratta richieste Art. 17.
