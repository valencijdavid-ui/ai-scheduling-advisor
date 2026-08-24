-- Fatto da Claude Code il 24 agosto 2026.
-- Riconciliazione della proiezione Google Calendar (PILOT-P0-1).
--
-- Perche' esiste: `calendar_sync_status` sapeva gia' dire `failed`, ma non
-- sapeva dire "da quanto", "quante volte" e "quando riprovare". Senza quei tre
-- dati non e' possibile ne' ritentare con criterio, ne' smettere, ne'
-- distinguere una riga rotta un minuto fa da una rotta da un giorno. Il
-- risultato era una colonna scritta da un solo punto del codice e letta da
-- nessuno: un guasto registrato fedelmente e invisibile a tutti.
--
-- Nessuna tabella nuova e nessuno stato nuovo. Lo stato desiderato vive gia'
-- sulla riga dell'appuntamento (tenant, orario, stato); qui si aggiunge solo
-- cio' che serve a governare i tentativi.
--
-- La terminalita' NON e' l'assenza di `calendar_sync_next_attempt_at`. E' un
-- predicato esplicito:
--
--   calendar_sync_status = 'failed'
--   AND (calendar_sync_attempts >= 5 OR scheduled_at <= now())
--
-- La colonna dei tentativi e' anche il testimone della rivendicazione
-- ottimistica del reconciler: si aggiorna solo se il valore letto e' ancora
-- quello atteso, quindi due worker sovrapposti non possono lavorare la stessa
-- riga.

alter table public.appointments
  add column if not exists calendar_sync_attempts integer not null default 0;

alter table public.appointments
  add column if not exists calendar_sync_next_attempt_at timestamptz;

alter table public.appointments
  add column if not exists calendar_sync_last_attempt_at timestamptz;

alter table public.appointments
  add constraint appointments_calendar_sync_attempts_non_negative
  check (calendar_sync_attempts >= 0)
  not valid;

alter table public.appointments
  validate constraint appointments_calendar_sync_attempts_non_negative;

-- Indice parziale sullo stesso predicato dello scanner: la stragrande
-- maggioranza delle righe ha `next_attempt_at` nullo (niente da fare) e non
-- deve nemmeno essere sfiorata. Stessa forma di
-- `whatsapp_outbox_jobs_ready_idx` e `appointments_reminder_due_idx`.
create index if not exists appointments_calendar_sync_due_idx
  on public.appointments(calendar_sync_next_attempt_at)
  where calendar_sync_next_attempt_at is not null
    and calendar_sync_status in ('pending', 'failed');

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
--
-- Due popolazioni, trattate in modo opposto e per un motivo preciso.
--
-- 1. Righe con `calendar_event_id`: hanno un'identita' su cui operare, quindi
--    entrano nella riconciliazione al primo tick. La convergenza legge prima
--    di scrivere, quindi anche se l'evento esiste gia' non ne nasce un
--    secondo.
--
-- 2. Righe SENZA `calendar_event_id`: sono il residuo del difetto che questo
--    lavoro chiude. Un fallimento azzerava la colonna, quindi una riga puo'
--    avere un evento reale su Google e nessun puntatore per ritrovarlo.
--    Derivare ora un id nuovo creerebbe il duplicato che l'intero disegno
--    serve a rendere impossibile. Vengono percio' rese terminali: restano
--    visibili all'operatore attraverso l'allarme, e nessun automatismo le
--    tocca.
--
-- In entrambi i casi si considerano solo gli appuntamenti futuri: sincronizzare
-- il calendario di ieri non serve a nessuno e terrebbe accesa per sempre una
-- riga irreparabile.

update public.appointments
set calendar_sync_attempts = 0,
    calendar_sync_next_attempt_at = now()
where calendar_provider = 'google_calendar'
  and calendar_sync_status in ('pending', 'failed')
  and calendar_event_id is not null
  and status in ('confirmed', 'cancelled')
  and scheduled_at > now();

update public.appointments
set calendar_sync_status = 'failed',
    calendar_sync_attempts = 5,
    calendar_sync_next_attempt_at = null,
    calendar_sync_error =
      'Legacy appointment without calendar_event_id: manual operator resolution required'
where calendar_provider = 'google_calendar'
  and calendar_sync_status in ('pending', 'failed')
  and calendar_event_id is null
  and status in ('confirmed', 'cancelled')
  and scheduled_at > now();

-- Le colonne ereditano le policy RLS gia' attive su `public.appointments`:
-- nessuna nuova tabella, nessuna nuova policy, `npm run db:lint` resta verde.
