-- PILOT-P0-3C-i — Correttezza dello scrittore + fondamenta dell'intento durevole.
--
-- IL CONTRATTO CHE QUESTA MIGRATION INSTALLA
--
--   Postgres e' autorevole. Google e' una proiezione derivata.
--
--   Ogni MUTAZIONE reale di un evento Google deve seguire:
--
--     INTENTO DI SCRITTURA DUREVOLE COMMITTATO
--       -> MUTAZIONE REMOTA
--         -> SETTLE CONDIZIONALE
--
--   Nessuna POST/PATCH/DELETE su un evento puo' avvenire senza un intento
--   gia' committato.
--
-- Le tre colonne monotone che seguono non sono contatori decorativi. Ognuna
-- risponde a una domanda diversa, e confonderle e' precisamente il difetto
-- che P0-3C ha trovato:
--
--   tenants.projection_epoch
--     "L'autorita' di proiettare PII di questo tenant su Google e' ancora
--      quella che lo scrittore aveva quando ha iniziato a lavorare?"
--     Avanza su cancellazione cliente. Deliberatamente GROSSOLANO: e'
--     tenant-wide, non per-cliente. Un fence per-soggetto richiederebbe di
--     conservare durevolmente un'identita' del soggetto — cioe' proprio il
--     dato che la cancellazione ha il compito di distruggere.
--
--   appointments.calendar_desired_version
--     "COSA deve esistere su Google adesso."
--     Avanza a ogni cambiamento autorevole dello stato proiettato.
--
--   appointments.calendar_write_generation
--     "QUALE tentativo di scrittura remota possiede l'autorita' di settle."
--     Avanza a ogni nuovo intento. Serve perche' due scrittori possono
--     condividere la stessa desired_version — il reconciler che ritenta
--     mentre l'inline sta ancora lavorando — e senza generation il piu'
--     vecchio potrebbe registrare il proprio esito sopra il piu' recente.
--
-- calendar_sync_attempts NON e' nessuna di queste tre: resta contabilita' di
-- retry/claim, non autorita' universale.
--
-- ATTENZIONE — CONFINE DI FASE (C-i):
--   Questa migration NON attiva le obbligazioni P0-3A, NON crea nessun worker
--   di cancellazione remota, NON introduce nessun cron e NON spazza gli
--   intenti orfani dentro le obbligazioni. Quello e' P0-3C-ii.
--   Fra C-i e C-ii un crash puo' lasciare un intento `in_flight` irrisolto:
--   e' evidenza durevole conservata di proposito, non un debito eseguibile.

-- ---------------------------------------------------------------------------
-- 1. Epoca di proiezione del tenant
-- ---------------------------------------------------------------------------

alter table public.tenants
  add column if not exists projection_epoch bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'tenants_projection_epoch_is_monotonic'
  ) then
    alter table public.tenants
      add constraint tenants_projection_epoch_is_monotonic check (projection_epoch >= 0);
  end if;
end $$;

comment on column public.tenants.projection_epoch is
  'Epoca dell''autorita'' di proiezione verso i sistemi esterni. MONOTONA. Avanza quando la cancellazione di un cliente rende non piu'' proiettabile la PII che uno scrittore in volo ha gia'' in memoria. Deliberatamente tenant-wide: un fence per-soggetto richiederebbe di conservare l''identita'' del soggetto cancellato. P0-3B riusera'' questa stessa colonna per la finalizzazione del tenant.';

-- ---------------------------------------------------------------------------
-- 2. Versione desiderata e generazione di scrittura dell'appuntamento
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column if not exists calendar_desired_version bigint not null default 0;

alter table public.appointments
  add column if not exists calendar_write_generation bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'appointments_calendar_versions_are_monotonic'
  ) then
    alter table public.appointments
      add constraint appointments_calendar_versions_are_monotonic
      check (calendar_desired_version >= 0 and calendar_write_generation >= 0);
  end if;
end $$;

comment on column public.appointments.calendar_desired_version is
  'COSA deve esistere su Google adesso. MONOTONA. Incrementata dalle primitive di scrittura E da un trigger di sicurezza su ogni mutazione di un campo proiettato: non e'' una convenzione applicativa che un percorso futuro possa dimenticare.';

comment on column public.appointments.calendar_write_generation is
  'QUALE tentativo di scrittura remota possiede l''autorita'' di settle. MONOTONA. Allocata atomicamente all''apertura di ogni intento durevole. Distinta da calendar_sync_attempts, che resta contabilita'' di retry/claim.';

-- Il trigger e' il motivo per cui desired_version non e' una convenzione.
--
-- Le primitive guardate sotto incrementano esplicitamente. Questo trigger
-- copre il caso che nessuna revisione del codice riesce a coprire: una
-- UPDATE futura, scritta da qualcun altro, su un campo che finisce dentro
-- l'evento Google. Senza, quella scrittura cambierebbe lo stato desiderato
-- lasciando la versione ferma, e un vecchio scrittore potrebbe registrare
-- come corrente una proiezione ormai sbagliata.
--
-- L'inventario dei campi proiettati e' preso da googleCalendarEventBody() e
-- da buildAppointmentCalendarSummary/Description in src/server:
--   scheduled_at, duration_minutes  -> start/end
--   status                          -> confirmed vs cancelled (delete)
--   notes, service_type             -> description/summary
--   customer_name, customer_phone   -> summary, description, extendedProperties
--
-- Oggi customer_name/customer_phone/service_type sono immutabili dopo la
-- creazione su tutti i percorsi applicativi: il trigger esiste perche'
-- domani potrebbero non esserlo piu'.
create or replace function public.appointments_guard_calendar_desired_version()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if (
       new.scheduled_at      is distinct from old.scheduled_at
    or new.duration_minutes  is distinct from old.duration_minutes
    or new.status            is distinct from old.status
    or new.notes             is distinct from old.notes
    or new.service_type      is distinct from old.service_type
    or new.customer_name     is distinct from old.customer_name
    or new.customer_phone    is distinct from old.customer_phone
  ) and new.calendar_desired_version = old.calendar_desired_version then
    new.calendar_desired_version := old.calendar_desired_version + 1;
  end if;

  return new;
end;
$$;

comment on function public.appointments_guard_calendar_desired_version() is
  'Rete di sicurezza: qualunque UPDATE che cambi un campo proiettato su Google e non abbia gia'' incrementato calendar_desired_version lo incrementa qui. Rende la versione un invariante del database, non una convenzione applicativa.';

drop trigger if exists appointments_guard_calendar_desired_version_trg on public.appointments;
create trigger appointments_guard_calendar_desired_version_trg
  before update on public.appointments
  for each row
  execute function public.appointments_guard_calendar_desired_version();

-- ---------------------------------------------------------------------------
-- 3. Intenti di scrittura durevoli
-- ---------------------------------------------------------------------------

-- COSA E' QUESTA TABELLA
--
--   Evidenza durevole che una mutazione remota PUO' essere stata in volo.
--
-- COSA NON E'
--
--   Non e' il debito canonico di cancellazione: quello resta
--   erasure_obligations. Le due non competono. In P0-3C-ii un intento
--   irrisolto potra' CAUSARE o RIAPRIRE un'obbligazione; qui non esiste
--   nessuna macchina che lo faccia, e non deve esistere.
create table if not exists public.calendar_write_intents (
  id uuid primary key default gen_random_uuid(),

  -- UUID NUDI. NESSUNA FOREIGN KEY. VEDI COMMENT SOTTO.
  tenant_ref uuid not null,
  appointment_ref uuid not null,

  -- Calendario che lo scrittore INTENDE contattare. Non e' ancora provenienza
  -- verificata: vedi calendar_identity_source.
  calendar_id text,
  external_event_id text,

  operation text not null
    check (operation in ('create', 'update', 'delete')),

  -- Da dove viene l'identita' del calendario, cioe' quanto vale come prova.
  --
  --   stored_provenance = l'appuntamento portava gia' un calendario provato
  --                       da una scrittura/lettura remota riuscita
  --   current_config    = ricaduta sulla configurazione CORRENTE
  --                       dell'integrazione: e' un'ipotesi, non una prova
  --   unknown           = nessuna delle due
  --
  -- Un 404 non promuove MAI current_config a stored_provenance: "non l'ho
  -- trovato qui" e "non esiste" sono fatti diversi.
  calendar_identity_source text not null default 'unknown'
    check (calendar_identity_source in ('stored_provenance', 'current_config', 'unknown')),

  projection_epoch bigint not null,
  desired_version bigint not null,
  write_generation bigint not null,

  -- in_flight          = committato, esito remoto non ancora registrato.
  --                      Un crash lo lascia QUI, ed e' giusto cosi': e'
  --                      l'unica affermazione onesta.
  -- settled            = l'esito remoto e' stato osservato e registrato.
  -- unknown_outcome    = timeout o guasto di trasporto DOPO una possibile
  --                      trasmissione. NON e' un fallimento: e' ignoranza.
  -- no_remote_mutation = nessuna mutazione remota e' partita (guasto con
  --                      status HTTP, o guasto su una sola lettura).
  -- manual_required    = serve un operatore.
  state text not null
    check (state in ('in_flight', 'settled', 'unknown_outcome', 'no_remote_mutation', 'manual_required')),

  -- Prova positiva raccolta sul calendario bersaglio. `absent_on_target` e'
  -- deliberatamente distinto da `write_confirmed`: e' il fatto che C-i
  -- conserva e che P0-3C-iii dovra' saper leggere.
  remote_evidence text
    check (remote_evidence is null or remote_evidence in
      ('none', 'event_observed', 'write_confirmed', 'absent_on_target')),

  attempts integer not null default 0 check (attempts >= 0),

  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  settled_at timestamptz,

  last_error_code text,

  -- last_error_code e' un CODICE, non un messaggio. Stessa disciplina di
  -- erasure_obligations, e per la stessa ragione: senza vincolo, il posto
  -- piu' comodo dove scaricare il corpo della risposta di Google sarebbe
  -- proprio questa colonna — e quel corpo contiene il telefono del cliente
  -- dentro extendedProperties.private.customerPhone.
  --
  -- Ci stanno `google_401`, `timeout`, `stale_desired_version`. Non ci sta
  -- un errore in prosa, non ci sta un JSON.
  constraint calendar_write_intents_error_code_is_bounded
    check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.-]{1,64}$')
);

comment on table public.calendar_write_intents is
  'Evidenza durevole che una mutazione di evento Google puo'' essere stata in volo. Infrastruttura service-role: nessun percorso di lettura per il tenant. NESSUNA colonna puo'' contenere PII del cliente. Non e'' il debito canonico di cancellazione (quello resta erasure_obligations): in P0-3C-ii un intento irrisolto potra'' causarne uno, ma quella macchina non esiste in C-i.';

comment on column public.calendar_write_intents.tenant_ref is
  'PLAIN UUID — AGGIUNGERE UNA FOREIGN KEY VERSO public.tenants E'' VIETATO. Stessa ragione di erasure_obligations.tenant_ref: ogni tabella tenant-scoped e'' ON DELETE CASCADE, e una FK farebbe sparire l''evidenza esattamente nell''istante in cui diventa insostituibile.';

comment on column public.calendar_write_intents.appointment_ref is
  'PLAIN UUID — AGGIUNGERE UNA FOREIGN KEY VERSO public.appointments E'' VIETATO. L''intento deve sopravvivere alla cancellazione dell''appuntamento: e'' precisamente il caso in cui serve, perche'' la riga locale spariva portandosi via l''unico puntatore all''evento remoto.';

comment on column public.calendar_write_intents.calendar_identity_source is
  'Quanto vale come prova il calendario bersaglio. current_config e'' un''IPOTESI derivata dalla configurazione corrente dell''integrazione, non una verita'' storica. Solo un''osservazione remota positiva puo'' promuovere l''evidenza; un 404/410 non promuove mai.';

comment on column public.calendar_write_intents.state is
  'in_flight = committato, esito remoto ignoto (un crash lascia QUI, ed e'' l''unica affermazione onesta). settled = esito osservato. unknown_outcome = timeout/trasporto dopo possibile trasmissione: ignoranza, NON fallimento. no_remote_mutation = nessuna mutazione e'' partita. manual_required = serve un operatore.';

comment on column public.calendar_write_intents.write_generation is
  'Generazione che possiede l''autorita'' di settle. Solo la generazione corrente dell''appuntamento puo'' registrare un esito: una generazione piu'' vecchia non puo'' MAI sovrascrivere una piu'' recente.';

-- Nessuna credenziale, nessun token, nessun nome, nessun telefono, nessun
-- corpo di richiesta o risposta Google, nessun testo di conversazione vive in
-- questa tabella: per questo non c'e' nessuna colonna per contenerli.

create index if not exists calendar_write_intents_unresolved_idx
  on public.calendar_write_intents (state, opened_at)
  where state in ('in_flight', 'unknown_outcome', 'manual_required');

create index if not exists calendar_write_intents_tenant_ref_idx
  on public.calendar_write_intents (tenant_ref);

create index if not exists calendar_write_intents_appointment_ref_idx
  on public.calendar_write_intents (appointment_ref);

alter table public.calendar_write_intents enable row level security;

-- Nessuna policy, e non e' una dimenticanza: RLS attivo senza policy nega
-- tutto a anon/authenticated. L'unico accesso e' service_role, che bypassa
-- RLS. Stessa postura di erasure_obligations.
revoke all on public.calendar_write_intents from public;
revoke all on public.calendar_write_intents from anon;
revoke all on public.calendar_write_intents from authenticated;
grant select, insert, update on public.calendar_write_intents to service_role;

-- ---------------------------------------------------------------------------
-- 4. Il fence: primitiva di lock del tenant
-- ---------------------------------------------------------------------------

-- FOR SHARE, NON FOR KEY SHARE. La differenza e' l'intero meccanismo.
--
-- L'incremento dell'epoca fatto dalla cancellazione e' una UPDATE su una
-- colonna non-chiave, quindi prende un lock di riga FOR NO KEY UPDATE.
--
--   FOR KEY SHARE  NON confligge con FOR NO KEY UPDATE.
--   FOR SHARE      CONFLIGGE con FOR NO KEY UPDATE.
--
-- Con FOR KEY SHARE le due transazioni scorrerebbero l'una accanto all'altra
-- senza vedersi, ed e' esattamente cio' che non deve succedere:
--
--   CASO A  lo scrittore tiene FOR SHARE
--           -> la UPDATE della cancellazione ASPETTA
--           -> lo scrittore committa
--           -> la cancellazione ottiene il lock, avanza l'epoca, e la sua
--              discovery POST-LOCK vede l'appuntamento appena inserito
--
--   CASO B  la UPDATE della cancellazione vince per prima
--           -> l'epoca diventa E+1
--           -> lo scrittore in attesa su FOR SHARE riparte, e la SUA lettura
--              con lock vede l'ultimo committed, cioe' E+1
--           -> l'epoca attesa E non combacia -> richiesta rifiutata
--           -> nessun insert, nessuna mutazione Google
--
-- Sotto READ COMMITTED una lettura con lock ri-valuta la riga sull'ultima
-- versione committata dopo l'attesa: e' quella ri-valutazione a rendere il
-- CASO B deterministico, e serve un lock che confligga per ottenerla.
create or replace function public.lock_tenant_projection_fence(p_tenant_id uuid)
returns bigint
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_epoch bigint;
begin
  select t.projection_epoch
    into v_epoch
    from public.tenants t
   where t.id = p_tenant_id
     for share;

  -- NULL = tenant assente. Chi chiama DEVE fallire chiuso: in C-i non esiste
  -- nessuno stato di grace o di finalizzazione da interpretare, e proiettare
  -- PII per un tenant che non c'e' piu' non e' un caso da indovinare.
  return v_epoch;
end;
$$;

comment on function public.lock_tenant_projection_fence(uuid) is
  'Fence dello scrittore: prende FOR SHARE sulla riga del tenant e ritorna l''epoca letta DA QUELLA lettura con lock. FOR KEY SHARE sarebbe sbagliato e silenzioso: non confligge con l''UPDATE dell''epoca. NULL = tenant assente, il chiamante deve fallire chiuso.';

revoke execute on function public.lock_tenant_projection_fence(uuid) from public, anon, authenticated;
grant execute on function public.lock_tenant_projection_fence(uuid) to service_role;

-- Lettura NON bloccante dell'epoca corrente, per la CATTURA PRECOCE.
--
-- La cattura avviene all'inizio del turno logico, prima che il workflow
-- cominci a trattenere o ad agire su dati del cliente. Non prende lock:
-- il lock serve al momento della scrittura, non al momento della lettura.
create or replace function public.read_tenant_projection_epoch(p_tenant_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select t.projection_epoch from public.tenants t where t.id = p_tenant_id;
$$;

comment on function public.read_tenant_projection_epoch(uuid) is
  'Cattura PRECOCE dell''epoca, senza lock. Va letta all''inizio del turno logico: leggerla appena prima della scrittura permetterebbe a PII vecchia di adottare l''epoca nuova, che e'' esattamente cio'' che il fence deve impedire.';

revoke execute on function public.read_tenant_projection_epoch(uuid) from public, anon, authenticated;
grant execute on function public.read_tenant_projection_epoch(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 5. CREATE: insert dell'appuntamento e apertura dell'intento, UNA transazione
-- ---------------------------------------------------------------------------

-- Perche' combinata e non due chiamate.
--
-- Se l'insert e l'apertura dell'intento fossero due transazioni, esisterebbe
-- una finestra reale:
--
--   appuntamento inserito -> il processo muore -> nessun intento durevole
--
-- e subito dopo quella finestra c'e' la create inline verso Google. Sarebbe
-- la stessa classe di difetto che questa fase esiste per chiudere, spostata
-- di due righe piu' in la'.
create or replace function public.create_appointment_with_calendar_intent(
  p_id uuid,
  p_tenant_id uuid,
  p_expected_projection_epoch bigint,
  p_conversation_id uuid,
  p_service_id uuid,
  p_service_name text,
  p_customer_identifier text,
  p_customer_name text,
  p_customer_phone text,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_notes text,
  p_booking_source text,
  p_calendar_provider text,
  p_calendar_sync_status text,
  p_calendar_event_id text,
  p_calendar_sync_next_attempt_at timestamptz,
  p_calendar_target text default null,
  p_calendar_identity_source text default 'unknown'
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_epoch bigint;
  v_intent_id uuid;
  v_generation bigint := 0;
  v_row public.appointments%rowtype;
begin
  -- 1. Fence. Prima di qualunque scrittura.
  v_epoch := public.lock_tenant_projection_fence(p_tenant_id);

  if v_epoch is null then
    return jsonb_build_object('outcome', 'tenant_gone');
  end if;

  -- 2. L'epoca CATTURATA PRESTO deve combaciare con quella letta sotto lock.
  if v_epoch <> p_expected_projection_epoch then
    return jsonb_build_object(
      'outcome', 'stale_projection_epoch',
      'expected', p_expected_projection_epoch,
      'observed', v_epoch
    );
  end if;

  if p_calendar_event_id is not null then
    v_generation := 1;
  end if;

  -- 3. Insert. Un conflitto di slot solleva e la transazione rollbacca
  --    intera: nessun intento orfano puo' restare.
  insert into public.appointments (
    id, tenant_id, conversation_id, service_id, customer_identifier, customer_name,
    customer_phone, scheduled_at, duration_minutes, service_type, status, notes,
    booking_source, calendar_provider, calendar_sync_status, calendar_event_id,
    calendar_event_calendar_id, calendar_sync_attempts, calendar_sync_next_attempt_at,
    calendar_desired_version, calendar_write_generation
  )
  values (
    p_id, p_tenant_id, p_conversation_id, p_service_id, p_customer_identifier, p_customer_name,
    p_customer_phone, p_scheduled_at, p_duration_minutes, p_service_name, 'confirmed', p_notes,
    p_booking_source, p_calendar_provider, p_calendar_sync_status, p_calendar_event_id,
    -- MAI provenienza verificata all'insert: qui non e' ancora successo niente
    -- su Google. Il bersaglio vive sull'intento; la colonna dell'appuntamento
    -- viene popolata solo da un settle che ha visto una prova positiva.
    null,
    0, p_calendar_sync_next_attempt_at,
    1, v_generation
  )
  returning * into v_row;

  -- 4. Intento durevole, nella STESSA transazione.
  if p_calendar_provider = 'google_calendar' and p_calendar_event_id is not null then
    insert into public.calendar_write_intents (
      tenant_ref, appointment_ref, calendar_id, external_event_id, operation,
      calendar_identity_source, projection_epoch, desired_version, write_generation,
      state, remote_evidence
    )
    values (
      p_tenant_id, p_id, p_calendar_target, p_calendar_event_id, 'create',
      coalesce(p_calendar_identity_source, 'unknown'), v_epoch, 1, v_generation,
      'in_flight', 'none'
    )
    returning id into v_intent_id;
  end if;

  return jsonb_build_object(
    'outcome', 'created',
    'appointmentId', v_row.id,
    'tenantId', v_row.tenant_id,
    'scheduledAt', v_row.scheduled_at,
    'durationMinutes', v_row.duration_minutes,
    'calendarSyncStatus', v_row.calendar_sync_status,
    'calendarEventId', v_row.calendar_event_id,
    'calendarEventHtmlLink', v_row.calendar_event_html_link,
    'projectionEpoch', v_epoch,
    'desiredVersion', v_row.calendar_desired_version,
    'writeGeneration', v_row.calendar_write_generation,
    'intentId', v_intent_id
  );
end;
$$;

comment on function public.create_appointment_with_calendar_intent(uuid, uuid, bigint, uuid, uuid, text, text, text, text, timestamptz, integer, text, text, text, text, text, timestamptz, text, text) is
  'CREATE fenced: FOR SHARE sul tenant, confronto con l''epoca catturata presto, insert dell''appuntamento e apertura dell''intento di scrittura in UNA transazione. Nessuna rete. Solo dopo il commit il chiamante puo'' contattare Google.';

revoke execute on function public.create_appointment_with_calendar_intent(uuid, uuid, bigint, uuid, uuid, text, text, text, text, timestamptz, integer, text, text, text, text, text, timestamptz, text, text)
  from public, anon, authenticated;
grant execute on function public.create_appointment_with_calendar_intent(uuid, uuid, bigint, uuid, uuid, text, text, text, text, timestamptz, integer, text, text, text, text, text, timestamptz, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 6. Intento di mutazione per un appuntamento gia' esistente
-- ---------------------------------------------------------------------------

create or replace function public.open_calendar_write_intent(
  p_tenant_id uuid,
  p_appointment_id uuid,
  p_expected_projection_epoch bigint,
  p_expected_desired_version bigint,
  p_operation text,
  p_calendar_id text,
  p_calendar_identity_source text,
  p_external_event_id text
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_epoch bigint;
  v_generation bigint;
  v_desired bigint;
  v_intent_id uuid;
begin
  v_epoch := public.lock_tenant_projection_fence(p_tenant_id);

  if v_epoch is null then
    return jsonb_build_object('outcome', 'tenant_gone');
  end if;

  if v_epoch <> p_expected_projection_epoch then
    return jsonb_build_object(
      'outcome', 'stale_projection_epoch',
      'expected', p_expected_projection_epoch,
      'observed', v_epoch
    );
  end if;

  -- Allocazione della generazione e verifica della versione desiderata nello
  -- STESSO statement: leggere, confrontare e poi scrivere da fuori sarebbe
  -- di nuovo una corsa, non un'autorizzazione.
  update public.appointments a
     set calendar_write_generation = a.calendar_write_generation + 1,
         updated_at = now()
   where a.tenant_id = p_tenant_id
     and a.id = p_appointment_id
     and a.calendar_desired_version = p_expected_desired_version
  returning a.calendar_write_generation, a.calendar_desired_version
       into v_generation, v_desired;

  if v_generation is null then
    -- Zero righe: o l'appuntamento non c'e' piu', o lo stato desiderato e'
    -- cambiato sotto i piedi dello scrittore. Sono due fatti diversi e
    -- vengono detti come due fatti diversi.
    if not exists (
      select 1 from public.appointments a
       where a.tenant_id = p_tenant_id and a.id = p_appointment_id
    ) then
      return jsonb_build_object('outcome', 'appointment_gone');
    end if;

    select a.calendar_desired_version into v_desired
      from public.appointments a
     where a.tenant_id = p_tenant_id and a.id = p_appointment_id;

    return jsonb_build_object(
      'outcome', 'desired_version_changed',
      'expected', p_expected_desired_version,
      'observed', v_desired
    );
  end if;

  insert into public.calendar_write_intents (
    tenant_ref, appointment_ref, calendar_id, external_event_id, operation,
    calendar_identity_source, projection_epoch, desired_version, write_generation,
    state, remote_evidence
  )
  values (
    p_tenant_id, p_appointment_id, p_calendar_id, p_external_event_id, p_operation,
    coalesce(p_calendar_identity_source, 'unknown'), v_epoch, v_desired, v_generation,
    'in_flight', 'none'
  )
  returning id into v_intent_id;

  return jsonb_build_object(
    'outcome', 'opened',
    'intentId', v_intent_id,
    'projectionEpoch', v_epoch,
    'desiredVersion', v_desired,
    'writeGeneration', v_generation
  );
end;
$$;

comment on function public.open_calendar_write_intent(uuid, uuid, bigint, bigint, text, text, text, text) is
  'Autorizzazione ATOMICA di una mutazione remota su un appuntamento esistente: fence FOR SHARE, confronto epoca, confronto desired_version, allocazione della write_generation e insert dell''intento in una sola transazione. Solo la generazione restituita e'' autorizzata a fare settle.';

revoke execute on function public.open_calendar_write_intent(uuid, uuid, bigint, bigint, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.open_calendar_write_intent(uuid, uuid, bigint, bigint, text, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 7. SETTLE unificato e TIPIZZATO
-- ---------------------------------------------------------------------------

-- Prima di questa funzione esistevano DUE implementazioni del settle — una
-- nel repository di booking, una in quello del reconciler — entrambe senza
-- CAS e nessuna delle due capace di accorgersi di aver toccato zero righe.
-- Un UPDATE che non trova niente non e' un errore per Postgres, e non lo era
-- nemmeno per il chiamante: zero righe e una riga erano lo stesso `undefined`.
--
-- Qui l'autorita' semantica e' UNA. La politica del chiamante puo' differire;
-- il significato di "questo esito e' stato registrato" no.
create or replace function public.settle_calendar_write(
  p_tenant_id uuid,
  p_appointment_id uuid,
  p_expected_projection_epoch bigint,
  p_expected_desired_version bigint,
  p_expected_write_generation bigint,
  p_calendar_sync_status text,
  p_calendar_sync_error text,
  p_calendar_sync_attempts integer,
  p_calendar_sync_next_attempt_at timestamptz,
  p_calendar_sync_last_attempt_at timestamptz,
  p_calendar_event_id text default null,
  p_calendar_event_calendar_id text default null,
  p_calendar_event_html_link text default null,
  p_set_html_link boolean default false,
  p_intent_id uuid default null,
  p_intent_state text default null,
  p_intent_error_code text default null,
  p_remote_evidence text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_outcome text;
  v_current_epoch bigint;
  v_desired bigint;
  v_generation bigint;
  v_exists boolean;
  v_settled integer := 0;
  v_reconvergence_marked boolean := false;
begin
  -- Nessun FOR SHARE qui, e non e' una svista.
  --
  -- Il settle non proietta niente: registra un esito gia' avvenuto. Prendere
  -- il lock del tenant anche qui aggiungerebbe contesa su ogni riga
  -- sincronizzata senza aggiungere nessuna sicurezza, perche' la CAS su
  -- (desired_version, write_generation) e' gia' la condizione che decide.
  select t.projection_epoch into v_current_epoch
    from public.tenants t where t.id = p_tenant_id;

  select a.calendar_desired_version, a.calendar_write_generation
    into v_desired, v_generation
    from public.appointments a
   where a.tenant_id = p_tenant_id and a.id = p_appointment_id;

  v_exists := v_desired is not null;

  if v_current_epoch is null then
    v_outcome := 'tenant_gone';
  elsif p_expected_projection_epoch is not null
        and v_current_epoch <> p_expected_projection_epoch then
    -- L'epoca e' avanzata: in questo tenant una cancellazione ha committato
    -- mentre lo scrittore era in volo. Non e' un caso in cui si possa
    -- dichiarare convergenza: quello che lo scrittore ha appena mandato a
    -- Google puo' contenere PII che non aveva piu' il diritto di proiettare.
    v_outcome := 'projection_epoch_advanced';
  elsif not v_exists then
    v_outcome := 'appointment_gone';
  elsif v_desired <> p_expected_desired_version then
    v_outcome := 'desired_version_changed';
  elsif v_generation <> p_expected_write_generation then
    v_outcome := 'write_generation_changed';
  else
    update public.appointments a
       set calendar_sync_status = p_calendar_sync_status,
           calendar_sync_error = case
             when p_calendar_sync_error is null then null
             else left(p_calendar_sync_error, 1000) end,
           calendar_sync_attempts = p_calendar_sync_attempts,
           calendar_sync_next_attempt_at = p_calendar_sync_next_attempt_at,
           calendar_sync_last_attempt_at = p_calendar_sync_last_attempt_at,
           -- L'identita' dell'evento non puo' essere CANCELLATA da un esito.
           -- Se Google avesse creato l'evento e la risposta si fosse persa,
           -- azzerare il puntatore produrrebbe un secondo evento al
           -- ritentativo.
           calendar_event_id = coalesce(p_calendar_event_id, a.calendar_event_id),
           -- Provenienza: scritta NELLO STESSO settle che registra lo stato
           -- sincronizzato, e solo quando il chiamante ha una prova positiva.
           -- Mai ricostruita dopo, rileggendo la configurazione corrente.
           calendar_event_calendar_id = coalesce(
             p_calendar_event_calendar_id, a.calendar_event_calendar_id),
           calendar_event_html_link = case
             when p_set_html_link then p_calendar_event_html_link
             else a.calendar_event_html_link end,
           updated_at = now()
     where a.tenant_id = p_tenant_id
       and a.id = p_appointment_id
       and a.calendar_desired_version = p_expected_desired_version
       and a.calendar_write_generation = p_expected_write_generation;

    get diagnostics v_settled = row_count;

    if v_settled = 1 then
      v_outcome := 'settled_current';
    else
      -- LA CAS HA PERSO, E IL PERCHE' NON SI PUO' INDOVINARE.
      --
      -- Fra la diagnosi qui sopra e questo UPDATE una transazione ha
      -- committato. Puo' aver spostato lo stato desiderato, puo' aver
      -- allocato una generazione piu' recente, e puo' aver CANCELLATO la riga
      -- — e' il caso della cancellazione GDPR, che e' precisamente la corsa
      -- per cui `appointment_gone` esiste.
      --
      -- Dichiarare `write_generation_changed` per tutti e tre farebbe dire
      -- alla primitiva una cosa falsa nel caso che conta di piu': un
      -- appuntamento sparito verrebbe raccontato come un appuntamento vivo
      -- con uno scrittore piu' recente, e chi legge l'esito — oggi il log,
      -- domani lo spazzino di C-ii — non saprebbe che l'unica cosa rimasta di
      -- quella riga e' l'intento.
      --
      -- Quindi si rilegge lo stato FRESCO. La rilettura non riapre nessuna
      -- corsa: qui non si scrive piu' niente sull'appuntamento, si sta solo
      -- dando un nome all'esito.
      select a.calendar_desired_version, a.calendar_write_generation
        into v_desired, v_generation
        from public.appointments a
       where a.tenant_id = p_tenant_id and a.id = p_appointment_id;

      if v_desired is null then
        -- La riga non c'e' piu'. `v_exists` va corretto: il blocco di
        -- riconvergenza sotto non ha piu' niente da rendere eleggibile.
        v_exists := false;
        v_outcome := 'appointment_gone';
      elsif v_desired <> p_expected_desired_version then
        v_outcome := 'desired_version_changed';
      else
        v_outcome := 'write_generation_changed';
      end if;
    end if;
  end if;

  -- RIPARAZIONE DEL RISULTATO REMOTO STANTIO.
  --
  -- Lo scenario e' questo, ed e' reale:
  --
  --   il vecchio scrittore ha desired v1, il nuovo ha v2
  --   il nuovo scrive Google (v2) e registra
  --   il vecchio scrive Google (v1) DOPO, e poi fallisce la CAS
  --
  -- Google adesso e' indietro. Scartare e basta il risultato del vecchio
  -- lascerebbe la riga `synced` con next_attempt_at NULL — cioe' invisibile
  -- allo scanner — sopra un evento remoto sbagliato.
  --
  -- Quindi: non si sovrascrive lo stato desiderato, non si lascia che un
  -- vecchio scrittore dichiari sincronizzato il presente, e si rende la
  -- proiezione CORRENTE di nuovo eleggibile alla riconvergenza.
  if v_exists and v_outcome in
       ('desired_version_changed', 'write_generation_changed', 'projection_epoch_advanced') then
    update public.appointments a
       set calendar_sync_status = case
             when a.calendar_sync_status = 'synced' then 'pending'
             else a.calendar_sync_status end,
           calendar_sync_next_attempt_at = case
             when a.calendar_sync_next_attempt_at is null
               or a.calendar_sync_next_attempt_at > p_calendar_sync_last_attempt_at
               then p_calendar_sync_last_attempt_at
             else a.calendar_sync_next_attempt_at end,
           updated_at = now()
     where a.tenant_id = p_tenant_id
       and a.id = p_appointment_id
       and a.calendar_provider = 'google_calendar'
       -- Una riga gia' terminale resta terminale: la riconvergenza non
       -- restituisce budget di tentativi a chi lo ha esaurito.
       --
       -- Il 5 e' CALENDAR_SYNC_MAX_ATTEMPTS (calendar-convergence.ts), lo
       -- stesso valore che usa il predicato dello scanner. Sono due copie
       -- della stessa soglia in due linguaggi, e una copia senza guardiano
       -- diverge: se il TypeScript salisse a 6 senza toccare questo file, le
       -- righe con 5 tentativi resterebbero eleggibili per lo scanner ma
       -- fuori dalla riparazione, cioe' `synced` sopra un evento stantio.
       --
       -- Il guardiano NON e' un accoppiamento a runtime — Postgres non legge
       -- TypeScript — ma un test che MISURA la soglia effettiva di questa
       -- funzione e la confronta con la costante di produzione:
       --   tests/server/appointments/calendar-settle-concurrency.pg.test.ts
       --   "repairs reconvergence up to exactly CALENDAR_SYNC_MAX_ATTEMPTS"
       -- Se le due divergono, in qualunque direzione, la CI fallisce.
       and a.calendar_sync_attempts < 5;

    v_reconvergence_marked := found;
  end if;

  -- L'intento si risolve SEMPRE, qualunque sia l'esito della CAS: il lavoro
  -- remoto e' avvenuto davvero, e la sua evidenza non dipende dall'aver
  -- vinto la corsa.
  if p_intent_id is not null then
    update public.calendar_write_intents i
       set state = coalesce(p_intent_state, i.state),
           remote_evidence = coalesce(p_remote_evidence, i.remote_evidence),
           attempts = i.attempts + 1,
           last_error_code = coalesce(
             p_intent_error_code,
             case when v_outcome = 'settled_current' then null else v_outcome end),
           settled_at = case
             when coalesce(p_intent_state, i.state) = 'in_flight' then null
             else now() end,
           updated_at = now()
     where i.id = p_intent_id;
  end if;

  return jsonb_build_object(
    'outcome', v_outcome,
    'observedDesiredVersion', v_desired,
    'observedWriteGeneration', v_generation,
    'observedProjectionEpoch', v_current_epoch,
    'reconvergenceMarked', v_reconvergence_marked
  );
end;
$$;

comment on function public.settle_calendar_write(uuid, uuid, bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text, text, text, boolean, uuid, text, text, text) is
  'Primitiva di settle UNICA per booking inline e reconciler. Condizionale su (tenant, appuntamento, desired_version, write_generation) e coerente con l''epoca catturata. Ritorna un esito TIPIZZATO: zero righe non e'' mai un successo generico. Se la CAS perde e la riga corrente esiste ancora, rende la proiezione di nuovo eleggibile alla riconvergenza invece di lasciarla `synced` sopra un evento remoto stantio.';

revoke execute on function public.settle_calendar_write(uuid, uuid, bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text, text, text, boolean, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_calendar_write(uuid, uuid, bigint, bigint, bigint, text, text, integer, timestamptz, timestamptz, text, text, text, boolean, uuid, text, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 8. RESCHEDULE e CANCEL guardati
-- ---------------------------------------------------------------------------

create or replace function public.reschedule_appointment_guarded(
  p_tenant_id uuid,
  p_appointment_id uuid,
  p_expected_projection_epoch bigint,
  p_scheduled_at timestamptz,
  p_duration_minutes integer,
  p_notes text,
  p_calendar_provider text,
  p_calendar_sync_status text,
  p_calendar_sync_next_attempt_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_epoch bigint;
  v_desired bigint;
begin
  v_epoch := public.lock_tenant_projection_fence(p_tenant_id);

  if v_epoch is null then
    return jsonb_build_object('outcome', 'tenant_gone');
  end if;

  if v_epoch <> p_expected_projection_epoch then
    return jsonb_build_object(
      'outcome', 'stale_projection_epoch', 'expected', p_expected_projection_epoch,
      'observed', v_epoch);
  end if;

  update public.appointments a
     set scheduled_at = p_scheduled_at,
         duration_minutes = p_duration_minutes,
         notes = p_notes,
         status = 'confirmed',
         calendar_provider = p_calendar_provider,
         calendar_sync_status = p_calendar_sync_status,
         calendar_sync_error = null,
         -- Uno spostamento e' uno stato desiderato NUOVO: i tentativi falliti
         -- sul precedente non consumano il budget di questo.
         calendar_sync_attempts = 0,
         calendar_sync_next_attempt_at = p_calendar_sync_next_attempt_at,
         calendar_desired_version = a.calendar_desired_version + 1,
         confirmation_queued_at = null,
         reminder_24h_queued_at = null,
         reminder_1h_queued_at = null,
         cancellation_queued_at = null,
         reminded_at = null,
         updated_at = now()
   where a.tenant_id = p_tenant_id
     and a.id = p_appointment_id
     and a.status = 'confirmed'
  returning a.calendar_desired_version into v_desired;

  if v_desired is null then
    return jsonb_build_object('outcome', 'not_confirmed');
  end if;

  return jsonb_build_object('outcome', 'rescheduled', 'desiredVersion', v_desired,
                            'projectionEpoch', v_epoch);
end;
$$;

comment on function public.reschedule_appointment_guarded(uuid, uuid, bigint, timestamptz, integer, text, text, text, timestamptz) is
  'Riprogrammazione autorevole guardata: fence del tenant, filtro status=confirmed, incremento ATOMICO di calendar_desired_version, esito tipizzato su zero righe.';

revoke execute on function public.reschedule_appointment_guarded(uuid, uuid, bigint, timestamptz, integer, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.reschedule_appointment_guarded(uuid, uuid, bigint, timestamptz, integer, text, text, text, timestamptz)
  to service_role;

-- La cancellazione riceve la STESSA sicurezza della riprogrammazione.
--
-- Il difetto che questo chiude: `cancelAppointmentRecord` filtrava su
-- status = 'confirmed' e non guardava mai le righe toccate. Se la riga era
-- gia' sparita — cancellazione GDPR, o annullamento concorrente — l'UPDATE
-- non trovava niente, nessuno se ne accorgeva, e il servizio proseguiva fino
-- a mandare una DELETE a Google per conto di uno stato autorevole che non
-- aveva mai cambiato.
--
-- "L'annullamento non rilancia mai" resta valido, ma DOPO che un annullamento
-- autorevole ha davvero committato — non al posto di quel commit.
create or replace function public.cancel_appointment_guarded(
  p_tenant_id uuid,
  p_appointment_id uuid,
  p_expected_projection_epoch bigint,
  p_calendar_sync_status text,
  p_calendar_sync_next_attempt_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_epoch bigint;
  v_desired bigint;
begin
  v_epoch := public.lock_tenant_projection_fence(p_tenant_id);

  if v_epoch is null then
    return jsonb_build_object('outcome', 'tenant_gone');
  end if;

  if v_epoch <> p_expected_projection_epoch then
    return jsonb_build_object(
      'outcome', 'stale_projection_epoch', 'expected', p_expected_projection_epoch,
      'observed', v_epoch);
  end if;

  update public.appointments a
     set status = 'cancelled',
         calendar_sync_status = p_calendar_sync_status,
         calendar_sync_error = null,
         calendar_sync_attempts = 0,
         calendar_sync_next_attempt_at = p_calendar_sync_next_attempt_at,
         reminder_24h_queued_at = null,
         reminder_1h_queued_at = null,
         calendar_desired_version = a.calendar_desired_version + 1,
         updated_at = now()
   where a.tenant_id = p_tenant_id
     and a.id = p_appointment_id
     and a.status = 'confirmed'
  returning a.calendar_desired_version into v_desired;

  if v_desired is null then
    return jsonb_build_object('outcome', 'not_confirmed');
  end if;

  return jsonb_build_object('outcome', 'cancelled', 'desiredVersion', v_desired,
                            'projectionEpoch', v_epoch);
end;
$$;

comment on function public.cancel_appointment_guarded(uuid, uuid, bigint, text, timestamptz) is
  'Annullamento autorevole guardato: stessa sicurezza della riprogrammazione. Zero righe e'' un esito tipizzato, non un silenzio, e il chiamante NON puo'' proseguire verso Google.';

revoke execute on function public.cancel_appointment_guarded(uuid, uuid, bigint, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.cancel_appointment_guarded(uuid, uuid, bigint, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- 9. RC-1 — la cancellazione avanza l'epoca PRIMA di guardare qualunque cosa
-- ---------------------------------------------------------------------------

-- Questa e' l'unica modifica a `erase_customer_data`, ed e' portante.
--
-- L'ordine e' cambiato: l'UPDATE che avanza projection_epoch e' ora la PRIMA
-- operazione sostanziale della transazione, prima della discovery delle
-- conversazioni, degli appuntamenti e della cattura del debito.
--
-- Perche' l'ordine decide.
--
-- Sotto READ COMMITTED ogni statement vede uno snapshot preso quando LO
-- STATEMENT inizia. Se la discovery girasse prima di prendere il lock
-- confliggente sul tenant, una prenotazione ancora NON committata sarebbe
-- invisibile a quella discovery, e resterebbe invisibile anche dopo:
--
--   discovery (non vede la prenotazione in volo)
--   la prenotazione committa
--   cancellazione committa
--   -> riga del cliente viva, nessun debito catturato, nessun segnale
--
-- Prendendo per primo il lock confliggente, quel caso si biforca in due
-- serializzazioni entrambe corrette:
--
--   la prenotazione vince   -> committa; la discovery POST-lock la vede e la
--                              cancella, catturando l'obbligazione normale
--   la cancellazione vince  -> l'epoca diventa E+1; la prenotazione in attesa
--                              riparte, legge E+1 sotto lock, non combacia
--                              con la E che aveva catturato, e viene rifiutata
--                              prima di inserire e prima di toccare Google
--
-- Tutto il resto della funzione — atomicita', cattura del debito, dedup,
-- rilevazione residua, audit — resta identico a P0-3A.
create or replace function public.erase_customer_data(
  p_tenant_id uuid,
  p_customer_phone text,
  p_request_id uuid,
  p_user_id uuid default null,
  p_ip_address text default null,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_norm text;
  v_projection_epoch bigint;
  v_conversation_ids uuid[];
  v_appointment_ids uuid[];
  v_message_ids uuid[];
  v_config_calendar_id text;
  v_has_google_authority boolean := false;
  v_known_event_rows integer := 0;
  v_unknown_event_rows integer := 0;
  v_local_deletion text;
  v_deleted_conversations integer := 0;
  v_deleted_messages integer := 0;
  v_deleted_appointments integer := 0;
  v_deleted_opt_outs integer := 0;
  v_deleted_voice_events integer := 0;
  v_deleted_scheduling_decisions integer := 0;
  v_dissociated_appointments integer := 0;
  v_pending_obligations integer := 0;
  v_manual_required integer := 0;
  v_residual_suspected integer := 0;
  v_executed_at timestamptz := now();
  v_ip inet;
begin
  -- 1. Normalizzazione DENTRO la primitiva.
  v_norm := regexp_replace(coalesce(p_customer_phone, ''), '[^0-9]', '', 'g');

  if length(v_norm) < 8 or length(v_norm) > 32 then
    raise exception 'Invalid customer phone number'
      using errcode = '22023';
  end if;

  -- 2. RC-1 — AVANZAMENTO DELL'EPOCA, PRIMA DI TUTTO.
  --
  --    Non e' contabilita': e' l'acquisizione del lock confliggente che
  --    serializza questa transazione contro ogni scrittore in volo. Deve
  --    stare PRIMA della discovery, non dopo, e non alla fine.
  update public.tenants t
     set projection_epoch = t.projection_epoch + 1,
         updated_at = now()
   where t.id = p_tenant_id
  returning t.projection_epoch into v_projection_epoch;

  if v_projection_epoch is null then
    -- Tenant assente: non c'e' niente da cancellare e nessuna autorita' da
    -- revocare. Meglio dirlo che fingere una cancellazione avvenuta.
    raise exception 'Tenant not found'
      using errcode = 'P0002';
  end if;

  -- Un IP malformato non deve far fallire una cancellazione GDPR.
  begin
    v_ip := nullif(btrim(coalesce(p_ip_address, '')), '')::inet;
  exception
    when others then
      v_ip := null;
  end;

  -- 3. Identita' corrente del calendario configurato. Fallback storico per le
  --    righe che non hanno provenienza.
  select coalesce(
           nullif(i.config ->> 'calendar_id', ''),
           nullif(i.config ->> 'calendarId', ''),
           nullif(i.external_account_id, ''),
           'primary'
         )
    into v_config_calendar_id
    from public.integrations i
   where i.tenant_id = p_tenant_id
     and i.provider = 'google_calendar'
     and i.status = 'active'
   limit 1;

  v_has_google_authority := v_config_calendar_id is not null;

  -- 4. Righe che appartengono con certezza al soggetto. Questa discovery gira
  --    ORA, cioe' DOPO il lock: vede tutto cio' che ha committato prima di
  --    noi, compresa una prenotazione che ci ha battuto sul filo.
  select coalesce(array_agg(c.id), '{}'::uuid[])
    into v_conversation_ids
    from public.conversations c
   where c.tenant_id = p_tenant_id
     and regexp_replace(c.customer_identifier, '[^0-9]', '', 'g') = v_norm;

  select coalesce(array_agg(a.id), '{}'::uuid[])
    into v_appointment_ids
    from public.appointments a
   where a.tenant_id = p_tenant_id
     and (
       regexp_replace(a.customer_identifier, '[^0-9]', '', 'g') = v_norm
       or regexp_replace(coalesce(a.customer_phone, ''), '[^0-9]', '', 'g') = v_norm
     );

  select coalesce(array_agg(m.id), '{}'::uuid[])
    into v_message_ids
    from public.messages m
   where m.tenant_id = p_tenant_id
     and m.conversation_id = any(v_conversation_ids);

  v_deleted_messages := coalesce(cardinality(v_message_ids), 0);

  -- 5. CATTURA dell'identita' remota, prima che la riga locale sparisca.
  --    `select distinct` resta obbligatorio: due appuntamenti possono portare
  --    lo stesso calendar_event_id e l'UPSERT solleverebbe 21000.
  insert into public.erasure_obligations (
    request_id, tenant_ref, obligation_type, status,
    calendar_id, external_event_id, next_attempt_at
  )
  select distinct
    p_request_id,
    p_tenant_id,
    'google_event_delete',
    case when v_has_google_authority then 'pending' else 'manual_required' end,
    case
      when nullif(a.calendar_event_calendar_id, '') is not null
        then nullif(a.calendar_event_calendar_id, '')
      when v_has_google_authority then v_config_calendar_id
      else null::text
    end,
    a.calendar_event_id,
    null::timestamptz
    from public.appointments a
   where a.id = any(v_appointment_ids)
     and a.calendar_provider = 'google_calendar'
     and a.calendar_event_id is not null
  on conflict (tenant_ref, calendar_id, external_event_id, obligation_type)
    where external_event_id is not null
  do update set
    status = excluded.status,
    request_id = excluded.request_id,
    resolved_at = null,
    attempts = 0,
    last_error_code = null,
    next_attempt_at = null;

  get diagnostics v_known_event_rows = row_count;

  if v_has_google_authority then
    v_pending_obligations := v_known_event_rows;
  else
    v_manual_required := v_known_event_rows;
  end if;

  -- 5b. Identita' remota ignota -> operatore. Nessun tentativo automatico.
  insert into public.erasure_obligations (
    request_id, tenant_ref, obligation_type, status,
    calendar_id, external_event_id, next_attempt_at
  )
  select
    p_request_id,
    p_tenant_id,
    'google_event_delete',
    'manual_required',
    coalesce(nullif(a.calendar_event_calendar_id, ''), v_config_calendar_id),
    null,
    null
    from public.appointments a
   where a.id = any(v_appointment_ids)
     and a.calendar_provider = 'google_calendar'
     and a.calendar_event_id is null;

  get diagnostics v_unknown_event_rows = row_count;
  v_manual_required := v_manual_required + v_unknown_event_rows;

  -- 6. Righe la cui UNICA aggancio al cliente verrebbe distrutto da questa
  --    stessa transazione (RC-3).
  delete from public.voice_events ve
   where ve.tenant_id = p_tenant_id
     and ve.message_id = any(v_message_ids);
  get diagnostics v_deleted_voice_events = row_count;

  delete from public.scheduling_decisions sd
   where sd.tenant_id = p_tenant_id
     and sd.conversation_id = any(v_conversation_ids);
  get diagnostics v_deleted_scheduling_decisions = row_count;

  -- 7. Appuntamenti di ALTRI clienti agganciati a una conversazione del
  --    soggetto (RC-2).
  update public.appointments a
     set conversation_id = null,
         updated_at = now()
   where a.tenant_id = p_tenant_id
     and a.conversation_id = any(v_conversation_ids)
     and not (a.id = any(v_appointment_ids));
  get diagnostics v_dissociated_appointments = row_count;

  -- 8. Appuntamenti PRIMA delle conversazioni.
  delete from public.appointments a
   where a.id = any(v_appointment_ids);
  get diagnostics v_deleted_appointments = row_count;

  -- 9. Conversazioni: i messaggi seguono per ON DELETE CASCADE.
  delete from public.conversations c
   where c.tenant_id = p_tenant_id
     and c.id = any(v_conversation_ids);
  get diagnostics v_deleted_conversations = row_count;

  delete from public.opt_outs o
   where o.tenant_id = p_tenant_id
     and regexp_replace(o.customer_identifier, '[^0-9]', '', 'g') = v_norm;
  get diagnostics v_deleted_opt_outs = row_count;

  -- 10. Rilevazione residua — SOLO rilevazione.
  if length(v_norm) >= 9 then
    select
      (select count(*)
         from public.conversations c
        where c.tenant_id = p_tenant_id
          and length(regexp_replace(c.customer_identifier, '[^0-9]', '', 'g')) >= 9
          and regexp_replace(c.customer_identifier, '[^0-9]', '', 'g') <> v_norm
          and right(regexp_replace(c.customer_identifier, '[^0-9]', '', 'g'), 9) = right(v_norm, 9))
      + (select count(*)
           from public.appointments a
          where a.tenant_id = p_tenant_id
            and (
              (length(regexp_replace(a.customer_identifier, '[^0-9]', '', 'g')) >= 9
               and regexp_replace(a.customer_identifier, '[^0-9]', '', 'g') <> v_norm
               and right(regexp_replace(a.customer_identifier, '[^0-9]', '', 'g'), 9) = right(v_norm, 9))
              or
              (length(regexp_replace(coalesce(a.customer_phone, ''), '[^0-9]', '', 'g')) >= 9
               and regexp_replace(coalesce(a.customer_phone, ''), '[^0-9]', '', 'g') <> v_norm
               and right(regexp_replace(coalesce(a.customer_phone, ''), '[^0-9]', '', 'g'), 9) = right(v_norm, 9))
            ))
      + (select count(*)
           from public.opt_outs o
          where o.tenant_id = p_tenant_id
            and length(regexp_replace(o.customer_identifier, '[^0-9]', '', 'g')) >= 9
            and regexp_replace(o.customer_identifier, '[^0-9]', '', 'g') <> v_norm
            and right(regexp_replace(o.customer_identifier, '[^0-9]', '', 'g'), 9) = right(v_norm, 9))
      into v_residual_suspected;
  end if;

  v_local_deletion := case
    when v_residual_suspected > 0 then 'manual_review_required'
    else 'complete'
  end;

  -- 11. Audit NELLA STESSA TRANSAZIONE, senza il numero del cliente.
  insert into public.audit_log (
    tenant_id, user_id, action, resource_type, resource_id,
    ip_address, user_agent, metadata
  )
  values (
    p_tenant_id,
    p_user_id,
    'gdpr.customer.deletion.executed',
    'customer',
    null,
    v_ip,
    nullif(btrim(coalesce(p_user_agent, '')), ''),
    jsonb_build_object(
      'requestId', p_request_id,
      'executedAt', v_executed_at,
      'localDeletion', v_local_deletion,
      'projectionEpoch', v_projection_epoch,
      'deleted', jsonb_build_object(
        'conversations', v_deleted_conversations,
        'messages', v_deleted_messages,
        'appointments', v_deleted_appointments,
        'optOuts', v_deleted_opt_outs,
        'voiceEvents', v_deleted_voice_events,
        'schedulingDecisions', v_deleted_scheduling_decisions
      ),
      'dissociatedAppointments', v_dissociated_appointments,
      'pendingObligations', v_pending_obligations,
      'manualRequired', v_manual_required,
      'residualSuspected', v_residual_suspected
    )
  );

  return jsonb_build_object(
    'requestId', p_request_id,
    'executedAt', v_executed_at,
    'localDeletion', v_local_deletion,
    'projectionEpoch', v_projection_epoch,
    'deleted', jsonb_build_object(
      'conversations', v_deleted_conversations,
      'messages', v_deleted_messages,
      'appointments', v_deleted_appointments,
      'optOuts', v_deleted_opt_outs,
      'voiceEvents', v_deleted_voice_events,
      'schedulingDecisions', v_deleted_scheduling_decisions
    ),
    'dissociatedAppointments', v_dissociated_appointments,
    'pendingObligations', v_pending_obligations,
    'manualRequired', v_manual_required,
    'residualSuspected', v_residual_suspected
  );
end;
$$;

comment on function public.erase_customer_data(uuid, text, uuid, uuid, text, text) is
  'GDPR Art. 17 customer-level: avanzamento dell''epoca di proiezione PRIMA di ogni discovery (RC-1), poi cancellazione locale ATOMICA e cattura del debito di cancellazione remota. Non contatta nessun sistema esterno. Nessuna rete dentro la transazione.';

revoke execute on function public.erase_customer_data(uuid, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.erase_customer_data(uuid, text, uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 10. CONFINE DI FASE — cio' che questa migration NON fa
-- ---------------------------------------------------------------------------
--
-- Le obbligazioni P0-3A restano INERTI: `pending` con next_attempt_at NULL.
-- Nessun backfill, nessun claim, nessun worker, nessun cron.
--
-- Nessuno spazzino converte gli intenti irrisolti in debito di cancellazione:
-- e' P0-3C-ii. Di conseguenza C4 — la riscoperta dell'identita' remota dopo
-- che l'appuntamento e' sparito — resta APERTA di proposito. Cio' che C-i
-- cambia e' che adesso quell'identita' SOPRAVVIVE, dentro
-- calendar_write_intents, invece di essere persa per sempre.
