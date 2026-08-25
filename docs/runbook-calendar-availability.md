# Runbook — Verifica della disponibilità Google Calendar

Cosa fare quando il watchdog segnala che una o più integrazioni Google Calendar
non riescono più a verificare la disponibilità (PILOT-P0-2).

Questo runbook è il complementare di [`runbook-calendar-sync.md`](./runbook-calendar-sync.md):
quello parla delle **scritture** (un appuntamento che esiste e non arriva sul
calendario), questo parla delle **letture** (un appuntamento che non nasce
perché non sappiamo se lo slot è libero).

## Il fatto da tenere presente prima di tutto

**Nessun appuntamento è stato preso male.** Il sistema non ha prenotato sopra
impegni esistenti e non ha inventato orari: si è fermato. Il cliente ha
ricevuto un messaggio che dice, in sostanza, "adesso non riesco a controllare
il calendario, riprova fra poco".

Quello che manca è la **capacità di prendere nuovi appuntamenti** per quel
tenant. Il sintomo visto da fuori — un numero WhatsApp che smette di prendere
appuntamenti — è identico a una giornata senza richieste, ed è la ragione per
cui questo allarme esiste.

## Il principio

Per un tenant con Google Calendar collegato:

> la disponibilità esiste **solo** se `freeBusy` è stata verificata.

Uno stato non verificabile non diventa mai `libero`, mai `[]`, mai "non ci
sono slot", mai una prenotazione solo-Postgres. Assenza di prova non è prova
di assenza.

Restano due stati **strutturalmente distinti**, e non vanno confusi:

| Stato | Comportamento |
|---|---|
| Nessuna integrazione Google | Disponibilità da Postgres. Corretto e voluto, invariato. |
| Google collegato ma non verificabile | Nessuna disponibilità. Risposta deterministica al cliente. |

## Stati di salute sull'integrazione

Due colonne su `public.integrations`, aggiunte da
`202608240003_calendar_availability_health.sql`:

| Colonna | Significato |
|---|---|
| `availability_error_code` | Codice stabile dell'ultimo guasto **permanente** (`google_availability_auth`). |
| `availability_error_at` | Quando è stato osservato. È la colonna che il watchdog legge. |

`integrations.status` **non viene toccato**, ed è deliberato: `status = 'active'`
è il criterio con cui la riconciliazione di PILOT-P0-1 seleziona l'integrazione
per portare su Google eventi già promessi al cliente. Marcare `error` qui
spegnerebbe anche quella, cioè un guasto di *lettura* cancellerebbe la
convergenza delle *scritture*.

Solo i guasti **specifici dell'integrazione** scrivono queste colonne:

- `invalid_grant` sul refresh token (consenso revocato)
- credenziali memorizzate assenti
- 401 certo da Google

I guasti passeggeri — 429, 5xx, timeout, **403 generico** — non scrivono nulla.
Google usa il 403 anche per quota e rate limit di progetto: trattarlo come
rottura permanente manderebbe in remediation integrazioni sane.

## Query di triage

```sql
-- Integrazioni attive che non verificano più la disponibilità.
select tenant_id, id, availability_error_code, availability_error_at
from public.integrations
where provider = 'google_calendar'
  and status = 'active'
  and availability_error_at is not null
order by availability_error_at asc;
```

## Remediation

La riconnessione OAuth è **l'unica** remediation, e la fa il tenant:

1. Il tenant apre **Impostazioni → Integrazioni**.
2. Disconnette e riconnette Google Calendar.

La riconnessione azzera entrambe le colonne nella stessa mutazione che
ripristina le credenziali, quindi l'allarme si spegne al tick successivo del
watchdog. Anche la disconnessione esplicita le azzera: un'integrazione rimossa
di proposito non deve restare sorvegliata, perché non c'è più niente da
ricollegare.

Non serve toccare il database a mano. Se lo si fa comunque, le due colonne si
muovono **sempre insieme** — c'è un check constraint che rende irrappresentabile
lo stato "codice senza data".

Un guasto passeggero non richiede nessuna azione: si risolve da solo e il
cliente ritenta.

## Osservabilità dei guasti passeggeri

I guasti passeggeri non mandano una mail per occorrenza e non hanno una tabella
di conteggio. L'unica traccia è una riga di log strutturata:

```
calendar_availability_unavailable
  tenantId, integrationId, kind, httpStatus, reason
```

`kind` è uno fra `transient`, `auth`, `invalid_response`, `configuration`,
`provider_rejected`. Nella riga non finiscono né il cliente (numero, nome) né
il corpo grezzo di Google né le credenziali.

Un picco di `kind: transient` su molti tenant insieme è Google, non noi. Un
`kind: configuration` è un problema di deploy (client OAuth non configurato) e
riguarda tutti i tenant.

## Recupero lato cliente

Il ritentativo è un **gesto esplicito del cliente**. Non esistono job di
riprovata, prenotazioni differite, o prenotazioni automatiche dopo il recupero.

Quando il cliente aveva già scelto uno slot e la conferma non è andata a buon
fine, la proposta e la sua scadenza originale restano intatte: al ritentativo
"confermo" riparte da dove si era fermato, con una **nuova verifica** della
disponibilità. Se nel frattempo la proposta è scaduta, vale il comportamento di
scadenza già esistente.

## Cosa questo non risolve

PILOT-P0-2 **non fornisce disponibilità durante un'indisponibilità totale di
Google**. Non c'è cache, non c'è fallback su dati vecchi, non c'è circuit
breaker. Se Google è giù, il tenant integrato non prende appuntamenti via
WhatsApp finché non torna — e lo fa dicendolo, invece di inventare orari.
