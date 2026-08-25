-- PILOT-P0-7A — riparazione della protezione contro gli appuntamenti sovrapposti.
--
-- Il problema
-- -----------
-- `202604240001_initial_backend_mvp.sql` chiudeva con una exclusion constraint
-- su `public.appointments` la cui espressione era
--
--   tstzrange(scheduled_at, scheduled_at + duration_minutes * interval '1 minute', '[)')
--
-- L'operatore `timestamptz + interval` e' STABLE, non IMMUTABLE: un interval
-- puo' contenere giorni o mesi, e risolverli dipende dal TimeZone di sessione.
-- PostgreSQL rifiuta quindi l'espressione con SQLSTATE 42P17 («functions in
-- index expression must be marked IMMUTABLE»).
--
-- Le conseguenze sono due, e sono diverse fra loro:
--
-- 1. Su un database NUOVO la migration iniziale aborta a quello statement.
--    Le migration non girano in un'unica transazione: tutto cio' che precede
--    e' gia' committato, ma `ON_ERROR_STOP` ferma il file e NESSUNA delle
--    migration successive viene applicata. Il database resta a meta'.
--
-- 2. Su un database GIA' DISPIEGATO la migration iniziale risulta applicata
--    nel registro, le migration successive sono passate, ma il vincolo non
--    e' mai esistito. Lo schema e' completo tranne la protezione.
--
-- Una migration additiva da sola non basta per il caso 1 — non viene mai
-- eseguita. Una correzione della migration storica da sola non basta per il
-- caso 2 — quel file non verra' mai rieseguito. Servono entrambe, ed e' per
-- questo che questa migration esiste accanto alla correzione storica.
--
-- Entrambe le popolazioni devono convergere sullo STESSO schema finale. Questo
-- file e' scritto per essere un no-op esatto su un database nato dalla
-- migration storica corretta.
--
-- La semantica non cambia
-- -----------------------
-- Il vincolo protegge quello che il vincolo originale intendeva proteggere, e
-- nient'altro:
--   * ambito di scheduling: `tenant_id` (la tabella non ha ne' risorsa ne'
--     operatore: non c'e' altra dimensione da rispettare);
--   * predicato: solo le righe `status = 'confirmed'`;
--   * intervallo half-open `[inizio, fine)`, quindi due appuntamenti
--     consecutivi che si toccano al minuto NON sono in conflitto.

-- ---------------------------------------------------------------------------
-- 1. L'espressione indicizzabile
-- ---------------------------------------------------------------------------
--
-- Identica per corpo e firma a quella creata dalla migration storica corretta:
-- `create or replace` la rende un no-op su un database gia' sano.
--
-- `make_interval(mins => n)` produce sempre e solo un intervallo di tempo puro
-- — 1440 minuti danno '24:00:00', non '1 day' — quindi la somma e' aritmetica
-- sull'istante e da' lo stesso risultato in ogni fuso, attraversamenti di ora
-- legale compresi. La dichiarazione IMMUTABLE e' vera, non una bugia detta al
-- pianificatore per farsi accettare l'indice.
--
-- `greatest(...)` tiene la funzione totale: `appointments.duration_minutes`
-- non ha un check di positivita', e senza questa clausola una durata non
-- positiva farebbe esplodere `tstzrange` con lower > upper.
create or replace function public.appointment_slot_range(
  p_scheduled_at timestamptz,
  p_duration_minutes integer
)
returns tstzrange
language sql
immutable
parallel safe
strict
as $$
  select tstzrange(
    p_scheduled_at,
    greatest(p_scheduled_at, p_scheduled_at + make_interval(mins => p_duration_minutes)),
    '[)'
  )
$$;

comment on function public.appointment_slot_range(timestamptz, integer) is
  'Intervallo [inizio, fine) occupato da un appuntamento. IMMUTABLE per poter comparire in una exclusion constraint GiST: make_interval produce un intervallo di solo tempo, quindi la somma non dipende dal TimeZone di sessione.';

-- ---------------------------------------------------------------------------
-- 2. Il vincolo
-- ---------------------------------------------------------------------------
--
-- Una exclusion constraint non ammette `NOT VALID`: PostgreSQL lo prevede solo
-- per CHECK e FOREIGN KEY. Non si puo' nemmeno agganciarla a un indice
-- costruito prima con `CREATE INDEX CONCURRENTLY` (`ADD CONSTRAINT ... USING
-- INDEX` vale solo per UNIQUE e PRIMARY KEY). La validazione e' quindi
-- inevitabilmente sincrona e tutto-o-niente.
--
-- Su un database dispiegato senza il vincolo possono essersi accumulate righe
-- sovrapposte, ed e' esattamente il difetto che questa migration chiude. In
-- quel caso l'ALTER fallirebbe con un 23P01 crudo, che non dice quante righe
-- siano ne' quali. Il pre-controllo qui sotto ferma la migration con una
-- diagnosi utilizzabile.
--
-- Fermarsi rumorosamente e' deliberato: saltare il vincolo in silenzio
-- lascerebbe le due popolazioni divergenti, cioe' il problema che questa
-- migration deve chiudere.
do $$
declare
  v_conflicts bigint;
  v_sample text;
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'appointments_no_confirmed_overlap'
      and conrelid = 'public.appointments'::regclass
  ) then
    return;
  end if;

  -- Self-join senza indice: l'indice che renderebbe la ricerca economica e'
  -- proprio quello che non esiste ancora. Il costo e' quadratico nel numero
  -- di appuntamenti confermati per tenant, accettabile alla scala del pilota
  -- e pagato una volta sola.
  create temporary table _p07a_overlaps on commit drop as
  with confirmed as (
    select
      id,
      tenant_id,
      public.appointment_slot_range(scheduled_at, duration_minutes) as slot
    from public.appointments
    where status = 'confirmed'
  )
  select
    a.id as left_id,
    b.id as right_id,
    a.tenant_id || ' ' || a.slot::text || ' vs ' || b.slot::text as sample
  from confirmed a
  join confirmed b
    on a.tenant_id = b.tenant_id
   and a.id < b.id
   and a.slot && b.slot;

  select count(*) into v_conflicts from _p07a_overlaps;

  if v_conflicts > 0 then
    -- Il conteggio e' totale, il campione no: cinque casi bastano a capire
    -- di che tipo di sovrapposizione si tratta senza riversare l'agenda
    -- nei log.
    select string_agg(sample, '; ')
    into v_sample
    from (select sample from _p07a_overlaps limit 5) s;

    raise exception using
      errcode = '23P01',
      message = format(
        'appointments_no_confirmed_overlap non applicabile: esistono %s coppie di appuntamenti confermati sovrapposti (primi casi: %s)',
        v_conflicts,
        coalesce(v_sample, '-')
      ),
      hint = 'Risolvere le sovrapposizioni preesistenti (annullare o riprogrammare le righe in conflitto) e rieseguire la migration.';
  end if;

  drop table _p07a_overlaps;

  alter table public.appointments
    add constraint appointments_no_confirmed_overlap
    exclude using gist (
      tenant_id with =,
      public.appointment_slot_range(scheduled_at, duration_minutes) with &&
    )
    where (status = 'confirmed');
end $$;
