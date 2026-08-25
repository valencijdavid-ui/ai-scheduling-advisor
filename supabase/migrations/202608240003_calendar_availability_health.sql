-- Fatto da Claude Code il 24 agosto 2026.
-- Salute della VERIFICA DI DISPONIBILITA' Google (PILOT-P0-2).
--
-- Perche' esiste: quando un tenant ha Google collegato, la disponibilita'
-- esiste solo se Google l'ha confermata. Un rifiuto permanente delle
-- credenziali (consenso revocato, refresh token invalidato) non produce piu'
-- prenotazioni sbagliate — il turno degrada in modo deterministico — ma
-- produce un tenant che non prenota piu' NIENTE, e senza queste due colonne
-- quel silenzio e' indistinguibile da una giornata senza richieste.
--
-- Il segnale sta sull'integrazione perche' e' l'integrazione a essere rotta:
-- non c'e' una riga di appuntamento su cui appoggiarlo, perche' proprio
-- l'appuntamento e' cio' che non e' stato creato.
--
-- `integrations.status` NON viene toccato, ed e' la decisione portante di
-- questa migration. La selezione dell'integrazione attiva (`status = 'active'`)
-- e' la stessa che PILOT-P0-1 usa per riconciliare gli eventi gia' promessi al
-- cliente: scrivere `status = 'error'` qui spegnerebbe anche quella, cioe' un
-- guasto di LETTURA cancellerebbe la convergenza delle SCRITTURE.
--
-- Nessuna tabella nuova: due colonne su una tabella che ha gia' la RLS giusta,
-- e che le eredita senza aggiungere superficie da proteggere.

-- Codice stabile dell'ultimo guasto PERMANENTE di verifica (es.
-- `google_availability_auth`). I guasti passeggeri — 429, 5xx, timeout, 403
-- generico — non scrivono qui: se lo facessero, il watchdog suonerebbe a ogni
-- singhiozzo di Google e smetterebbe di significare qualcosa.
alter table public.integrations
  add column if not exists availability_error_code text;

-- Quando il guasto e' stato osservato. E' la colonna che il watchdog legge:
-- valorizzata = questa integrazione ha bisogno di essere ricollegata.
alter table public.integrations
  add column if not exists availability_error_at timestamptz;

-- Le due colonne si muovono insieme, sempre. Uno stato "codice senza data" o
-- "data senza codice" non ha lettura possibile: il vincolo lo rende
-- irrappresentabile invece di lasciarlo a una convenzione scritta altrove.
alter table public.integrations
  add constraint integrations_availability_error_pair
  check (
    (availability_error_code is null and availability_error_at is null)
    or (availability_error_code is not null and availability_error_at is not null)
  )
  not valid;

alter table public.integrations
  validate constraint integrations_availability_error_pair;

-- Indice parziale sulla stessa forma della query del watchdog: la quasi
-- totalita' delle righe ha la colonna nulla e non deve essere sfiorata.
-- Stessa forma di `appointments_calendar_sync_due_idx`.
create index if not exists integrations_availability_error_idx
  on public.integrations(availability_error_at)
  where availability_error_at is not null;

-- La RLS e' gia' abilitata su `public.integrations` dalla migration iniziale e
-- la policy `integrations_tenant_all` copre tutte le colonne della riga: le due
-- nuove non aggiungono percorsi di lettura fuori dal tenant.
