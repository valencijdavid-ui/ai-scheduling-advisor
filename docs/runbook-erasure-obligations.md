# Runbook — Debito di cancellazione su Google Calendar

Riguarda la tabella `erasure_obligations` e i segnali del watchdog
`erasure.pendingObligations` / `erasure.manualRequiredObligations`.

## Cosa sta succedendo, in una riga

Quando un cliente esercita il diritto alla cancellazione (GDPR Art. 17), i suoi
dati locali vengono cancellati in **una transazione**. L'evento sul Google
Calendar dello studio, pero', vive fuori dal nostro database — e contiene nome e
telefono del cliente (`extendedProperties.private.customerPhone`). Quella
cancellazione remota viene **registrata** come obbligazione durevole.

## STATO ATTUALE — leggere prima di intervenire

**PILOT-P0-3A cattura il debito remoto ma NON lo converge.**

Non esiste ancora nessun worker, nessun cron e nessuna route che cancelli eventi
su Google. Ogni obbligazione nasce `pending` con `next_attempt_at = NULL`, cioe'
deliberatamente **non eseguibile**.

Questo non e' un guasto ed e' inutile segnalarlo come tale:

- `pending` con `next_attempt_at NULL` in P0-3A e' **lo stato atteso**;
- `NULL` **non** significa "convergente" ne' "terminale": significa "non ancora
  eseguibile";
- la convergenza automatica arriva con **P0-3C**, che deve prima stabilire un
  contratto di coordinamento con gli scrittori Google gia' esistenti.

**P0-3A da solo NON e' pilot-complete.** Restano obbligatori P0-3B (grace period
e finalizzazione del tenant), P0-3C (convergenza remota e chiusura della race
con il reconciler), P0-4 (media vocali su Storage), P0-5 (`webhook_events` e PII
residua), P0-6 (testi legali).

## Ordine di rilascio — MIGRATION PRIMA DEL CODICE

`npx supabase db push` **deve** essere applicato prima di rilasciare il codice
applicativo di P0-3A. Non e' una preferenza di stile.

Il watchdog legge i conteggi da `erasure_obligations` a ogni giro
(`*/15 * * * *`) e propaga l'errore se la lettura fallisce. Se il codice arriva
per primo, quella tabella non esiste ancora e **l'intero watchdog smette di
produrre un report** — non solo la parte sulla cancellazione. Si perderebbe la
visibilita' su outbox, dead letter e salute del calendario proprio durante un
rilascio, cioe' nel momento in cui serve di piu'.

La route di cancellazione ha lo stesso vincolo per la RPC
`public.erase_customer_data`, ma li' il danno si ferma alla richiesta che
fallisce.

## Segnali del watchdog

| Segnale | Stato | Significato |
|---|---|---|
| `erasure.pendingObligations > 0` | **non allarma** | Debito catturato, non ancora convergibile. Atteso in P0-3A. |
| `erasure.manualRequiredObligations > 0` | **critical** | Nessun automatismo potra' chiuderlo. Serve una persona. |

Solo `manual_required` alza lo stato. Allarmare su `pending` prima di P0-3C
vorrebbe dire suonare senza sosta per una condizione nota e non risolvibile,
cioe' insegnare a ignorare il watchdog.

## Perche' una obbligazione diventa `manual_required`

1. **Identita' remota ignota** — l'appuntamento aveva
   `calendar_provider = 'google_calendar'` ma `calendar_event_id` NULL. L'evento
   puo' esistere su Google senza che noi ne conosciamo l'id. Non e'
   ricostruibile a posteriori: `NULL` va letto come **ignoto**, mai come
   "gia' pulito".
2. **Autorita' perduta** — al momento della cancellazione il tenant non aveva
   nessuna integrazione `google_calendar` in stato `active`. L'evento e'
   conosciuto, ma non abbiamo il token per cancellarlo.

Nel caso 2 la riga conserva `calendar_id` **solo se** l'appuntamento aveva una
provenienza registrata (`appointments.calendar_event_calendar_id`). Altrimenti
`calendar_id` e' **NULL**, e va letto come "calendario ignoto".

Non e' un buco da tappare: e' l'unica scrittura onesta. Riempire quel campo con
`primary` produrrebbe una riga che sembra eseguibile, il DELETE andrebbe sul
calendario sbagliato, riceverebbe 404 — che per `cancelEvent` vale successo
idempotente — e l'obbligazione si chiuderebbe mentre l'evento, con dentro il
telefono del cliente, resta vivo. Per questo il vincolo di schema **permette**
`external_event_id` valorizzato con `calendar_id` NULL, ma solo negli stati che
nessun automatismo prende in carico (`manual_required`, `voided`).

## Come si risolve a mano

Serve accesso service-role al database e l'accesso dello studio al proprio
Google Calendar. La tabella non contiene nessun dato del cliente: non si puo'
risalire alla persona partendo da li', e non e' un difetto ma il progetto.

1. Elencare il debito aperto:

```sql
select id, tenant_ref, status, calendar_id, external_event_id, created_at
from public.erasure_obligations
where status in ('pending', 'manual_required')
order by created_at;
```

2. Per una riga con `external_event_id` valorizzato, l'evento e' identificabile:
   calendario `calendar_id`, evento `external_event_id`. Gli id sono
   deterministici (`apt<uuid-hex>`).

3. Per una riga **senza** `external_event_id`, l'evento va cercato sul
   calendario dello studio nella finestra temporale della richiesta di
   cancellazione (`created_at`), confrontandolo con `request_id` nell'audit:

```sql
select created_at, metadata
from public.audit_log
where action = 'gdpr.customer.deletion.executed'
  and metadata ->> 'requestId' = '<request_id>';
```

L'audit **non** contiene il numero del cliente, per costruzione. Se serve
sapere di chi era la richiesta, la fonte e' la richiesta GDPR originale
ricevuta dallo studio, non i nostri log.

4. Cancellato l'evento su Google, chiudere la riga:

```sql
update public.erasure_obligations
set status = 'converged', resolved_at = now()
where id = '<obligation_id>';
```

## `residualSuspected` e `localDeletion` nella risposta API

La cancellazione automatica confronta **solo cifre normalizzate uguali**. Un
numero salvato in forma nazionale (`3331112233`) e una richiesta con prefisso
internazionale (`393331112233`) **non** vengono trattati come la stessa persona:
cancellare su quella base significherebbe distruggere i dati di un altro
cliente.

Quando restano righe che condividono il suffisso, la risposta riporta
`residualSuspected > 0` **e** `localDeletion = 'manual_review_required'`.
Vanno esaminate a mano: se sono davvero lo stesso soggetto, si ripete la
richiesta di cancellazione **con la forma effettivamente memorizzata**.

`localDeletion` ha due valori e nessun altro:

| Valore | Significato |
|---|---|
| `complete` | L'identita' esatta e' sparita e non e' rimasto niente che possa essere lo stesso soggetto. |
| `manual_review_required` | La transazione ha committato, ma restano righe potenzialmente della stessa persona. Serve un occhio umano. |

**`localDeletion` e `remoteCleanup` sono due dimensioni distinte.** La prima e'
ambiguita' di identita' locale, la seconda e' debito su Google. Si chiudono in
due modi diversi — rileggendo l'anagrafica una, cancellando un evento l'altra —
e una richiesta puo' benissimo essere `complete` in locale e `pending` in
remoto, o il contrario.

## Cosa NON fare

- Non aggiungere una foreign key da `erasure_obligations.tenant_ref` a
  `tenants`. Il debito sparirebbe esattamente quando il tenant viene
  hard-deleted, cioe' quando si perde per sempre l'autorita' per onorarlo.
- Non copiare credenziali OAuth nella tabella. Il worker di P0-3C leggera' le
  credenziali correnti tramite `tenant_ref`.
- Non chiudere una riga come `converged` senza aver verificato che l'evento sia
  davvero sparito dal calendario indicato in `calendar_id`. Un DELETE mandato al
  calendario sbagliato riceve 404, che per l'API Google e' un successo
  idempotente: l'obbligazione risulterebbe chiusa e l'evento resterebbe vivo
  altrove.
