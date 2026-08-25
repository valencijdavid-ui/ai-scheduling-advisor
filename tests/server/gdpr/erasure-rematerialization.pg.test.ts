// PILOT-P0-3C — CARATTERIZZAZIONE. La meta' su Postgres reale di C5.
//
// `tests/server/appointments/booking-erasure-races.test.ts` dimostra, a
// livello di servizio, che una prenotazione gia' in volo scrive localmente e
// su Google l'identita' di un cliente appena cancellato.
//
// Qui si dimostra l'altra meta', quella che rende il difetto INVISIBILE: la
// cattura del debito remoto e' una fotografia di `public.appointments` presa
// nell'istante della transazione. Se in quell'istante l'appuntamento non
// esiste ancora, non c'e' niente da fotografare — e nessun meccanismo
// successivo torna a guardare.
//
// L'ordine che conta e' questo:
//
//   1. la cancellazione committa      -> zero obbligazioni
//   2. l'insert della prenotazione     -> riga viva con l'identita' cancellata
//   3. nessuno se ne accorge mai
//
// E' distinto dalla matrice R1/R2, dove l'appuntamento ESISTE al momento
// della cattura e l'obbligazione, per quanto inerte, viene almeno creata.
// Qui non viene creata affatto.

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const CALENDAR_ID = 'studio@example.com';
const PHONE = '393331112233';

type ErasureResult = {
  localDeletion: 'complete' | 'manual_review_required';
  deleted: { appointments: number; conversations: number };
  pendingObligations: number;
  manualRequired: number;
  residualSuspected: number;
};

describePg('PILOT-P0-3C — caratterizzazione della rimaterializzazione post-erasure', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  it('characterizes an erasure capturing no obligation when the appointment does not exist yet', () => {
    const seed = seedCustomerWithoutAppointment(db);

    const result = erase(db, seed);

    // La cancellazione ha lavorato: la conversazione del cliente e' sparita.
    expect(result.deleted.conversations).toBe(1);
    expect(result.deleted.appointments).toBe(0);

    // E dichiara — correttamente, per cio' che poteva vedere — che non c'e'
    // nessun debito remoto.
    expect(result.pendingObligations).toBe(0);
    expect(result.manualRequired).toBe(0);
    expect(result.localDeletion).toBe('complete');
    expect(obligationCount(db, seed.tenantId)).toBe(0);
  });

  it('characterizes the in-flight booking landing after the erasure with no debt captured', () => {
    const seed = seedCustomerWithoutAppointment(db);

    // 1. La cancellazione committa.
    const result = erase(db, seed);
    expect(result.pendingObligations).toBe(0);
    expect(obligationCount(db, seed.tenantId)).toBe(0);

    // 2. La prenotazione in volo atterra: l'insert porta l'identita' del
    //    cliente cancellato, con il suo evento Google.
    const appointmentId = randomUUID();
    const eventId = `apt${appointmentId.replace(/-/g, '')}`;

    db.exec(`
      insert into public.appointments
        (id, tenant_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_sync_status, calendar_event_id)
      values ('${appointmentId}', '${seed.tenantId}', '${PHONE}', 'Mario Rossi', '${PHONE}',
              now() + interval '2 days', 'google_calendar', 'synced', '${eventId}');
    `);

    // 3. Lo stato risultante: PII del cliente viva in locale e su Google,
    //    ZERO obbligazioni, e nessun segnale da nessuna parte.
    const rows = db.query<{ customer_phone: string; calendar_event_id: string }>(
      `select customer_phone, calendar_event_id from public.appointments
        where tenant_id = '${seed.tenantId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.customer_phone).toBe(PHONE);
    expect(rows[0]?.calendar_event_id).toBe(eventId);
    expect(obligationCount(db, seed.tenantId)).toBe(0);

    // Il watchdog legge esattamente questi due conteggi: entrambi a zero.
    const watched = db.query<{ status: string; n: number }>(
      `select status, count(*)::int as n from public.erasure_obligations
        where tenant_ref = '${seed.tenantId}' group by status`,
    );
    expect(watched).toEqual([]);

    // POST_ERASURE_REMATERIALIZATION_POSSIBLE = TRUE
  });

  it('characterizes the residual detector being blind to the rematerialized row', () => {
    // `residualSuspected` e' l'unico rilevatore di "e' rimasto qualcosa" che
    // la cancellazione possiede. Guarda solo alias con prefisso diverso, e
    // guarda PRIMA che la riga nuova esista: non e' e non puo' essere una
    // difesa contro questa corsa.
    const seed = seedCustomerWithoutAppointment(db);
    const result = erase(db, seed);

    expect(result.residualSuspected).toBe(0);

    db.exec(`
      insert into public.appointments
        (id, tenant_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_event_id)
      values ('${randomUUID()}', '${seed.tenantId}', '${PHONE}', 'Mario Rossi', '${PHONE}',
              now() + interval '2 days', 'google_calendar', 'apt_rematerialized');
    `);

    // La riga esiste adesso, ma l'esito gia' restituito diceva `complete` e
    // nessuno lo rivedra'.
    expect(result.localDeletion).toBe('complete');
    expect(
      db.query(`select id from public.appointments where tenant_id = '${seed.tenantId}'`),
    ).toHaveLength(1);
  });

  it('contrasts the same erasure capturing the debt when the appointment already exists', () => {
    // Il contrasto isola la variabile: identica cancellazione, identico
    // cliente, identico evento — cambia solo se la riga esisteva al momento
    // della transazione.
    const seed = seedCustomerWithoutAppointment(db);
    const appointmentId = randomUUID();
    const eventId = `apt${appointmentId.replace(/-/g, '')}`;

    db.exec(`
      insert into public.appointments
        (id, tenant_id, customer_identifier, customer_name, customer_phone,
         scheduled_at, calendar_provider, calendar_event_id)
      values ('${appointmentId}', '${seed.tenantId}', '${PHONE}', 'Mario Rossi', '${PHONE}',
              now() + interval '2 days', 'google_calendar', '${eventId}');
    `);

    const result = erase(db, seed);

    expect(result.deleted.appointments).toBe(1);
    expect(result.pendingObligations).toBe(1);
    expect(obligationCount(db, seed.tenantId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Seed = { tenantId: string; userId: string };

function seedCustomerWithoutAppointment(db: TestDatabase): Seed {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const conversationId = randomUUID();

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into auth.users (id) values ('${userId}');
    insert into public.users (id, tenant_id, role) values ('${userId}', '${tenantId}', 'owner');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);

    insert into public.conversations (id, tenant_id, channel, customer_identifier)
    values ('${conversationId}', '${tenantId}', 'whatsapp', '${PHONE}');
  `);

  return { tenantId, userId };
}

function erase(db: TestDatabase, seed: Seed): ErasureResult {
  const rows = db.query<{ result: ErasureResult }>(
    `select public.erase_customer_data(
       '${seed.tenantId}'::uuid, '${PHONE}', '${randomUUID()}'::uuid,
       '${seed.userId}'::uuid, null, 'Vitest') as result`,
  );

  const result = rows[0]?.result;

  if (!result) {
    throw new Error('erase_customer_data returned no result');
  }

  return result;
}

function obligationCount(db: TestDatabase, tenantId: string): number {
  const rows = db.query<{ n: number }>(
    `select count(*)::int as n from public.erasure_obligations where tenant_ref = '${tenantId}'`,
  );

  return Number(rows[0]?.n ?? 0);
}
