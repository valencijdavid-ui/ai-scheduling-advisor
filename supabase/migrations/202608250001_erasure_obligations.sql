-- PILOT-P0-3A — Erasure core + durable Google erasure obligations.
--
-- Il difetto che questa migration esiste per chiudere e' gia' in produzione
-- (F3): la cancellazione di un cliente esegue cinque DELETE indipendenti via
-- PostgREST, nell'ordine sbagliato. `messages` viene cancellato e committato;
-- poi il DELETE su `conversations` fallisce con 23503 su
-- `appointments_conversation_id_fkey` (la FK e' NO ACTION, vedi
-- 202604240001 riga 132) perche' l'appuntamento punta ancora alla
-- conversazione. Risultato: messaggi distrutti, conversazione e appuntamento
-- vivi, nessun audit scritto, nessun rollback possibile.
--
-- Qui la cancellazione diventa UNA transazione: o cade tutto, o non cade
-- niente.
--
-- Il secondo problema e' fuori dal database: gli eventi su Google Calendar.
-- Quando l'appuntamento sparisce, sparisce anche l'unico puntatore
-- all'evento remoto — che contiene nome e telefono del cliente
-- (extendedProperties.private.customerPhone, vedi src/server/calendar/google.ts).
-- Percio' l'identita' remota va CATTURATA nella stessa transazione che
-- distrugge la riga locale, in una tabella che sopravvive.
--
-- ATTENZIONE — CONFINE DI FASE:
-- P0-3A CATTURA il debito di cancellazione remota. NON lo esegue.
-- Nessun worker, nessun cron, nessuna chiamata a Google fanno parte di
-- questa fase. L'esecuzione arriva in P0-3C, dopo che sara' stato stabilito
-- un contratto di coordinamento con gli scrittori Google gia' esistenti.
-- P0-3A da solo NON e' pilot-complete.

-- ---------------------------------------------------------------------------
-- 1. Provenienza del calendario sull'appuntamento
-- ---------------------------------------------------------------------------

-- Su quale calendario e' stato scritto DAVVERO l'evento.
--
-- Serve perche' `integrations.config.calendar_id` e' configurazione CORRENTE,
-- non verita' storica: se il tenant cambia calendario (o riconnette Google,
-- che rimette 'primary'), un DELETE mirato al calendario sbagliato riceve 404
-- — e 404 per `cancelEvent` significa "successo idempotente". L'obbligazione
-- risulterebbe convergente mentre l'evento, con dentro il telefono del
-- cliente, resta vivo altrove.
--
-- P0-3C popolera' questa colonna a ogni sync riuscito. Per le righe legacy
-- resta NULL e la cattura ricade sulla configurazione corrente: limite noto,
-- coperto dal gate pre-pilot sulla storia del calendario, NON risolvibile a
-- posteriori.
alter table public.appointments
  add column if not exists calendar_event_calendar_id text;

comment on column public.appointments.calendar_event_calendar_id is
  'Calendario Google su cui l''evento e'' stato effettivamente sincronizzato. NULL = sconosciuto (riga legacy): la cattura P0-3A ricade sulla config corrente. Popolata dai sync riusciti a partire da P0-3C.';

-- ---------------------------------------------------------------------------
-- 2. Obbligazioni di cancellazione remota
-- ---------------------------------------------------------------------------

create table if not exists public.erasure_obligations (
  id uuid primary key default gen_random_uuid(),

  -- Richiesta di cancellazione che ha generato l'obbligazione. Correla
  -- l'audit con il debito remoto senza conservare l'identita' del soggetto.
  request_id uuid not null,

  -- UUID NUDO. NESSUNA FOREIGN KEY VERSO tenants. VEDI COMMENT SOTTO.
  tenant_ref uuid not null,

  obligation_type text not null
    check (obligation_type in ('google_event_delete')),

  status text not null
    check (status in ('scheduled', 'pending', 'converged', 'manual_required', 'voided')),

  calendar_id text,
  external_event_id text,

  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz,
  last_attempt_at timestamptz,
  last_error_code text,

  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Un evento noto senza calendario non e' ESEGUIBILE: l'id dell'evento da
  -- solo non identifica l'oggetto remoto, e un worker non saprebbe dove
  -- andarlo a cancellare. Gli stati che un automatismo puo' prendere in
  -- carico non possono quindi rappresentarlo.
  --
  -- `manual_required` invece si'. "Conosciamo l'id dell'evento ma non il
  -- calendario" e' esattamente lo stato di un tenant che ha revocato Google:
  -- e' una condizione reale, e va registrata com'e'. L'alternativa —
  -- inventare un calendario pur di far passare il vincolo — produrrebbe una
  -- riga che SEMBRA eseguibile; P0-3C la cancellerebbe sul calendario
  -- sbagliato, riceverebbe 404, e per `cancelEvent` il 404 vale successo
  -- idempotente. Il debito risulterebbe chiuso e l'evento, che contiene il
  -- telefono del cliente, resterebbe vivo. Il vincolo ammette lo stato
  -- onesto proprio per non costringere a quella bugia.
  --
  -- `voided` (P0-3B) e' terminale e non esegue niente: stesso trattamento.
  constraint erasure_obligations_executable_needs_calendar
    check (
      external_event_id is null
      or calendar_id is not null
      or status in ('manual_required', 'voided')
    ),

  -- last_error_code e' un CODICE, non un messaggio.
  --
  -- P0-3C dovra' registrare perche' un tentativo e' fallito, e senza vincolo
  -- il posto piu' comodo dove scaricare il corpo della risposta di Google
  -- sarebbe proprio questa colonna. Ma la risposta di Google su un evento
  -- contiene il telefono del cliente dentro extendedProperties: quella
  -- colonna diventerebbe il rientro dalla finestra della PII che tutta la
  -- tabella e' costruita per non contenere.
  --
  -- Ci stanno `google_401`, `timeout`, `retry_exhausted`. Non ci sta un
  -- errore in prosa.
  constraint erasure_obligations_error_code_is_bounded
    check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_.-]{1,64}$')
);

comment on table public.erasure_obligations is
  'Debito di cancellazione di PII su sistemi esterni (oggi: eventi Google Calendar). Infrastruttura service-role: nessun percorso di lettura per il tenant. P0-3A cattura, P0-3C converge.';

-- Questo commento e' il punto piu' importante della migration.
comment on column public.erasure_obligations.tenant_ref is
  'PLAIN UUID — AGGIUNGERE UNA FOREIGN KEY VERSO public.tenants E'' VIETATO. Ogni tabella tenant-scoped e'' ON DELETE CASCADE: una FK qui farebbe sparire l''obbligazione esattamente nell''istante in cui il tenant viene hard-deleted, cioe'' l''istante in cui l''autorita'' per cancellare l''evento remoto viene persa per sempre. Il debito deve sopravvivere alla riga che lo ha generato.';

comment on column public.erasure_obligations.next_attempt_at is
  'Quando l''obbligazione torna eleggibile per il worker. NULL = NON ancora eseguibile: NON significa convergente ne'' terminale. In P0-3A ogni obbligazione pending nasce con NULL perche'' il worker remoto non esiste ancora (arriva in P0-3C).';

comment on column public.erasure_obligations.status is
  'scheduled = debito reversibile del grace period tenant (riservato a P0-3B, non usato da P0-3A). pending = debito durevole e non risolto. converged = oggetto remoto cancellato. manual_required = serve un operatore (identita'' remota ignota, o autorita'' perduta). voided = annullata (P0-3B).';

comment on column public.erasure_obligations.calendar_id is
  'Calendario catturato al momento della cancellazione locale. Il worker DEVE usare questo valore, non la config corrente dell''integrazione.';

-- Nessuna credenziale, nessun token, nessun identificativo del cliente vive
-- in questa tabella: per questo non c'e' nessuna colonna per contenerli.

-- Dedup stabile del debito su un evento noto CON calendario noto.
--
-- Copre TUTTI gli status di proposito: esiste al massimo una riga per identita'
-- remota, quindi una obbligazione `converged` puo' essere RIAPERTA a `pending`
-- con lo stesso upsert. Serve a P0-3C: se uno scrittore P0-1 in volo ricrea
-- l'evento dopo la cancellazione, il debito deve poter tornare aperto invece
-- di duplicarsi.
--
-- Le righe `manual_required` con calendar_id NULL restano FUORI dal dedup: in
-- un indice unico due NULL sono valori distinti e non collidono mai. E'
-- voluto. Dedurre che due debiti dal calendario ignoto siano lo stesso oggetto
-- remoto sarebbe un'inferenza non verificabile, e chiuderne uno credendo di
-- averli chiusi entrambi lascerebbe PII viva su Google. Meglio una riga in
-- piu' da chiudere a mano che una in meno.
create unique index if not exists erasure_obligations_known_event_unique_idx
  on public.erasure_obligations (tenant_ref, calendar_id, external_event_id, obligation_type)
  where external_event_id is not null;

-- Debito non risolto, per watchdog e (in P0-3C) per il claim del worker.
create index if not exists erasure_obligations_unresolved_idx
  on public.erasure_obligations (status, created_at)
  where status in ('scheduled', 'pending', 'manual_required');

create index if not exists erasure_obligations_tenant_ref_idx
  on public.erasure_obligations (tenant_ref);

alter table public.erasure_obligations enable row level security;

-- Nessuna policy, e non e' una dimenticanza: RLS attivo senza policy nega
-- tutto a anon/authenticated. L'unico accesso e' service_role, che bypassa
-- RLS. Il tenant non ha nessun percorso di lettura su questa tabella.

-- ---------------------------------------------------------------------------
-- 3. Cancellazione atomica dei dati di un cliente
-- ---------------------------------------------------------------------------

-- SECURITY INVOKER, non DEFINER.
--
-- Il server chiama gia' con SUPABASE_SERVICE_ROLE_KEY, che ha BYPASSRLS: i
-- privilegi del chiamante bastano. DEFINER aggiungerebbe solo il rischio noto
-- del pattern gia' presente in questo repo — una GRANT accidentale a
-- `authenticated` su una funzione DEFINER che accetta p_tenant_id aprirebbe
-- l'accesso cross-tenant in silenzio. Con INVOKER la stessa GRANT sbagliata
-- resta inerte: la funzione girerebbe con i privilegi (vincolati da RLS) del
-- chiamante.
--
-- L'autorizzazione applicativa (owner/admin) resta a monte, nel service.
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
  --
  -- I percorsi di scrittura salvano il numero con la formattazione ricevuta
  -- (booking.ts fa solo trim), quindi il confronto deve essere indipendente
  -- dalla rappresentazione. Non ci si fida della normalizzazione fatta dalla
  -- route: e' un input, non una garanzia.
  v_norm := regexp_replace(coalesce(p_customer_phone, ''), '[^0-9]', '', 'g');

  if length(v_norm) < 8 or length(v_norm) > 32 then
    raise exception 'Invalid customer phone number'
      using errcode = '22023';
  end if;

  -- Un IP malformato non deve far fallire una cancellazione GDPR.
  begin
    v_ip := nullif(btrim(coalesce(p_ip_address, '')), '')::inet;
  exception
    when others then
      v_ip := null;
  end;

  -- 2. Identita' corrente del calendario configurato. Fallback storico per le
  --    righe che non hanno provenienza (vedi colonna calendar_event_calendar_id).
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

  -- AUTORITA'.
  --
  -- Senza un'integrazione Google attiva non abbiamo il token per cancellare
  -- niente, e nemmeno un modo onesto di sapere su quale calendario l'evento
  -- fosse scritto. Il coalesce qui sopra garantisce un valore non nullo
  -- quando l'integrazione esiste ('primary' e' la semantica corrente
  -- dell'integrazione attiva, non un'invenzione): quindi NULL qui significa
  -- esattamente "nessuna autorita'".
  --
  -- Da qui in giu' questa variabile decide se un evento noto sia un debito
  -- che una macchina potra' chiudere o un debito che va a un operatore.
  v_has_google_authority := v_config_calendar_id is not null;

  -- 3. Righe che appartengono con certezza al soggetto.
  --
  -- Solo uguaglianza esatta sulle cifre normalizzate. MAI suffisso: un
  -- confronto per suffisso cancellerebbe il cliente sbagliato.
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

  -- 4. CATTURA dell'identita' remota, prima che la riga locale sparisca.
  --
  -- Un calendar_event_id NULL non e' "gia' pulito": e' IGNOTO. L'evento puo'
  -- esistere su Google senza che noi ne conosciamo l'id, e nessuna
  -- ricostruzione a posteriori e' possibile. Diventa debito per un operatore.
  -- 4a. Evento noto.
  --
  --     `select distinct` non e' un dettaglio di stile: due appuntamenti del
  --     soggetto possono portare lo STESSO calendar_event_id (righe legacy,
  --     import, correzioni a mano — niente in `appointments` lo vieta, e
  --     aggiungere ora un vincolo unico romperebbe dati che esistono gia').
  --     Senza dedup, l'UPSERT multi-riga tocca due volte la stessa
  --     obbligazione e Postgres solleva 21000 "ON CONFLICT DO UPDATE command
  --     cannot affect row a second time". La transazione rollbacca pulita, ma
  --     ogni ritentativo fallisce identico: la cancellazione di quel cliente
  --     diventerebbe impossibile per sempre. Si deduplica sull'identita'
  --     REMOTA (calendario + evento), non sull'appuntamento: e' l'oggetto
  --     Google che va cancellato una volta sola.
  --
  --     `null::timestamptz` e' obbligatorio: sotto DISTINCT un NULL nudo
  --     risolve a text e lo statement non compila.
  --
  --     next_attempt_at NULL e' deliberato: il worker remoto arriva in P0-3C.
  insert into public.erasure_obligations (
    request_id, tenant_ref, obligation_type, status,
    calendar_id, external_event_id, next_attempt_at
  )
  select distinct
    p_request_id,
    p_tenant_id,
    'google_event_delete',
    -- Evento noto ma nessuna autorita' Google: nessun automatismo potra'
    -- chiuderlo, quindi nasce gia' come debito di un operatore.
    case when v_has_google_authority then 'pending' else 'manual_required' end,
    -- MAI un calendario inventato.
    --   provenienza registrata            -> quella, sempre, anche senza autorita'
    --                                        (serve all'operatore per rimediare)
    --   nessuna provenienza + autorita'   -> calendario corrente dell'integrazione
    --   nessuna provenienza + nessuna     -> NULL. Ignoto si scrive ignoto.
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
    -- Riapertura: un debito gia' convergente torna aperto se la stessa
    -- identita' remota viene ricatturata.
    status = excluded.status,
    request_id = excluded.request_id,
    resolved_at = null,
    attempts = 0,
    last_error_code = null,
    next_attempt_at = null;

  -- Righe DAVVERO create o riaperte, non appuntamenti che le hanno generate:
  -- due appuntamenti sullo stesso evento sono un debito solo.
  get diagnostics v_known_event_rows = row_count;

  if v_has_google_authority then
    v_pending_obligations := v_known_event_rows;
  else
    v_manual_required := v_known_event_rows;
  end if;

  -- 4b. Identita' remota ignota -> operatore. Nessun tentativo automatico.
  --
  --     Niente dedup qui, ed e' voluto: senza id dell'evento non esiste
  --     un'identita' remota su cui deduplicare, e collassare due righe
  --     significherebbe dichiarare che due eventi ignoti sono lo stesso.
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

  -- 5. Righe la cui UNICA aggancio al cliente verrebbe distrutto da questa
  --    stessa transazione (RC-3).
  --
  --    voice_events.message_id e scheduling_decisions.conversation_id sono
  --    ON DELETE SET NULL: se cancellassimo prima i genitori, queste righe
  --    resterebbero orfane con dentro contenuto del cliente e nessun modo di
  --    ricondurle a lui. Non e' P0-5 rimandabile: e' l'ultimo momento in cui
  --    sono indirizzabili.
  delete from public.voice_events ve
   where ve.tenant_id = p_tenant_id
     and ve.message_id = any(v_message_ids);
  get diagnostics v_deleted_voice_events = row_count;

  delete from public.scheduling_decisions sd
   where sd.tenant_id = p_tenant_id
     and sd.conversation_id = any(v_conversation_ids);
  get diagnostics v_deleted_scheduling_decisions = row_count;

  -- 6. Appuntamenti di ALTRI clienti agganciati a una conversazione del
  --    soggetto (RC-2).
  --
  --    Non sono suoi: non vanno cancellati e non generano debito remoto. Ma
  --    finche' puntano alla conversazione, la FK NO ACTION impedisce di
  --    cancellarla. Si sgancia il riferimento e si preserva la riga.
  update public.appointments a
     set conversation_id = null,
         updated_at = now()
   where a.tenant_id = p_tenant_id
     and a.conversation_id = any(v_conversation_ids)
     and not (a.id = any(v_appointment_ids));
  get diagnostics v_dissociated_appointments = row_count;

  -- 7. Appuntamenti PRIMA delle conversazioni. Questo e' il fix di F3.
  delete from public.appointments a
   where a.id = any(v_appointment_ids);
  get diagnostics v_deleted_appointments = row_count;

  -- 8. Conversazioni: i messaggi seguono per ON DELETE CASCADE, e con loro
  --    whatsapp_outbox_jobs e whatsapp_voice_jobs.
  delete from public.conversations c
   where c.tenant_id = p_tenant_id
     and c.id = any(v_conversation_ids);
  get diagnostics v_deleted_conversations = row_count;

  delete from public.opt_outs o
   where o.tenant_id = p_tenant_id
     and regexp_replace(o.customer_identifier, '[^0-9]', '', 'g') = v_norm;
  get diagnostics v_deleted_opt_outs = row_count;

  -- 9. Rilevazione residua — SOLO rilevazione.
  --
  --    '3331112233' (nazionale) e '393331112233' (con prefisso) possono essere
  --    la stessa persona, ma possono anche non esserlo. Cancellare su questa
  --    base sarebbe distruggere i dati di un altro cliente, quindi qui non si
  --    cancella niente: si conta, e il conteggio diventa debito per un
  --    operatore. Nessun identificativo del soggetto viene conservato.
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

  -- 9b. Esito LOCALE, detto senza abbellirlo.
  --
  --     L'identita' normalizzata esatta e' stata cancellata: questo e' un
  --     fatto. Ma se restano righe che potrebbero essere la stessa persona
  --     sotto un altro prefisso, dire "completo" sarebbe far passare per
  --     chiusa una cancellazione che ha ancora bisogno di un occhio umano —
  --     e nessuno andra' a leggere un contatore in fondo alla risposta se il
  --     titolo dice che e' tutto a posto.
  --
  --     Resta una dimensione a se': il debito GOOGLE vive in remoteCleanup /
  --     manualRequired. Ambiguita' locale e debito remoto non si sommano e
  --     non si sostituiscono, perche' si chiudono in due modi diversi.
  v_local_deletion := case
    when v_residual_suspected > 0 then 'manual_review_required'
    else 'complete'
  end;

  -- 10. Audit NELLA STESSA TRANSAZIONE, senza il numero del cliente.
  --
  --     Il record di una cancellazione non deve conservare l'identificativo
  --     che gli e' stato chiesto di cancellare. requestId basta a correlare
  --     audit e debito remoto.
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
  'GDPR Art. 17 customer-level: cancellazione locale ATOMICA + cattura del debito di cancellazione remota. Non contatta nessun sistema esterno. Nessuna rete dentro la transazione.';

revoke execute on function public.erase_customer_data(uuid, text, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.erase_customer_data(uuid, text, uuid, uuid, text, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. Bonifica dell'audit storico
-- ---------------------------------------------------------------------------

-- L'audit_log e' progettato per sopravvivere alla cancellazione del tenant
-- (tenant_id ON DELETE SET NULL, vedi 202605080001). Finora ha conservato il
-- telefono del cliente in chiaro dentro metadata.customerPhone — cioe' proprio
-- l'identificativo che le due azioni GDPR avevano il compito di trattare.
--
-- Le righe NON vengono cancellate: e' il registro di conformita'. Viene tolta
-- solo la chiave. Idempotente.
update public.audit_log
   set metadata = metadata - 'customerPhone'
 where action in ('gdpr.customer.deletion.executed', 'gdpr.customer.export.requested')
   and metadata ? 'customerPhone';
