// PILOT-P0-3C-i × PILOT-P0-7A — composizione fra il vincolo di esclusione e
// l'intento di scrittura durevole, su PostgreSQL vero.
//
// P0-7A ha riparato `appointments_no_confirmed_overlap` e lo ha reso
// APPLICABILE. Da quel momento `23P01` non e' piu' un caso teorico: e' l'esito
// normale di due prenotazioni concorrenti sullo stesso slot.
//
// Questo cambia il terreno sotto C-i. La primitiva di creazione scrive DUE
// cose nella stessa transazione — la riga dell'appuntamento e l'intento di
// scrittura verso Google — e l'intento e' progettato per SOPRAVVIVERE a tutto,
// compresa la cancellazione della riga e del tenant. Un intento che
// sopravvivesse anche a un insert MAI avvenuto sarebbe un debito verso un
// evento remoto che nessuno ha mai chiesto di creare: il worker di C-ii
// andrebbe a cercarlo, e il 404 che riceve non e' distinguibile da un evento
// creato e poi perso.
//
// Le proprieta' qui sono quindi tre, e sono di composizione, non di uno solo
// dei due lavori:
//
//   1. chi perde la corsa perde INSIEME riga e intento
//   2. la sconfitta e' un esito di DOMINIO, non un rifiuto del fence
//   3. chi vince conserva riga e intento intatti

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const CALENDAR_ID = 'studio@example.com';
const PHONE = '393331112233';

describePg('PILOT-P0-3C-i × P0-7A — 23P01 e intento durevole', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  it('applies the repaired exclusion constraint, so 23P01 is a real outcome', () => {
    const constraints = db.query<{ conname: string; contype: string }>(
      `select conname, contype from pg_constraint
        where conrelid = 'public.appointments'::regclass
          and conname = 'appointments_no_confirmed_overlap'`,
    );

    // Se questo vincolo non esistesse, tutto il resto del file proverebbe una
    // proprieta' su un caso che non puo' verificarsi.
    expect(constraints).toEqual([{ conname: 'appointments_no_confirmed_overlap', contype: 'x' }]);
  });

  it('rolls the durable intent back with the appointment that lost the slot', () => {
    const tenant = seedTenant(db);
    const slot = "now() + interval '2 days'";

    const winner = createAppointment(db, { tenantId: tenant, scheduledAt: slot });
    expect(winner.outcome).toBe('created');

    // Stesso tenant, stesso slot: il vincolo di P0-7A deve rifiutare.
    const loser = attemptCreate(db, { tenantId: tenant, scheduledAt: slot });

    expect(loser.sqlState).toBe('23P01');

    // LA PROPRIETA'. L'intento perdente non e' rimasto indietro: c'e' un solo
    // intento per questo tenant, ed e' quello del vincitore.
    const intents = db.query<{ id: string; external_event_id: string }>(
      `select id, external_event_id from public.calendar_write_intents
        where tenant_ref = '${tenant}'`,
    );

    expect(intents).toHaveLength(1);
    expect(intents[0]?.external_event_id).toBe(winner.calendarEventId);

    // E nemmeno la riga: un solo appuntamento confermato.
    expect(
      db.query(
        `select id from public.appointments
          where tenant_id = '${tenant}' and status = 'confirmed'`,
      ),
    ).toHaveLength(1);
  });

  it('leaves the winner row and its intent fully intact after the loser fails', () => {
    const tenant = seedTenant(db);
    const slot = "now() + interval '3 days'";

    const winner = createAppointment(db, { tenantId: tenant, scheduledAt: slot });
    attemptCreate(db, { tenantId: tenant, scheduledAt: slot });

    const rows = db.query<{
      state: string;
      external_event_id: string;
      calendar_id: string;
      write_generation: number;
    }>(
      `select state, external_event_id, calendar_id, write_generation
         from public.calendar_write_intents where tenant_ref = '${tenant}'`,
    );

    // Il fallimento del perdente e' avvenuto in una transazione separata e non
    // ha toccato niente di cio' che il vincitore aveva committato.
    expect(rows).toEqual([
      {
        state: 'in_flight',
        external_event_id: winner.calendarEventId,
        calendar_id: CALENDAR_ID,
        // Prima generazione allocata: e' l'unica che potra' fare settle su
        // questa riga, e il perdente non ne ha consumata nessuna.
        write_generation: 1,
      },
    ]);
  });

  it('does not disguise a lost slot as a stale projection epoch', () => {
    const tenant = seedTenant(db);
    const slot = "now() + interval '4 days'";

    createAppointment(db, { tenantId: tenant, scheduledAt: slot });

    // L'epoca passata e' quella CORRENTE: il fence e' soddisfatto, e l'unica
    // ragione del fallimento e' lo slot occupato. Se la primitiva rispondesse
    // `stale_projection_epoch` il cliente riceverebbe l'invito a ricominciare
    // il turno per un motivo che non e' successo.
    const loser = attemptCreate(db, { tenantId: tenant, scheduledAt: slot });

    expect(loser.sqlState).toBe('23P01');
    expect(loser.text).not.toContain('stale_projection_epoch');

    expect(db.scalar(`select public.read_tenant_projection_epoch('${tenant}'::uuid)`)?.trim()).toBe(
      '0',
    );
  });

  it('refuses a reschedule into an occupied slot without granting write authority', () => {
    const tenant = seedTenant(db);
    const occupied = "now() + interval '5 days'";

    createAppointment(db, { tenantId: tenant, scheduledAt: occupied });
    const mover = createAppointment(db, {
      tenantId: tenant,
      scheduledAt: "now() + interval '6 days'",
    });

    const before = desiredVersion(db, mover.appointmentId);

    const failed = attempt(
      db,
      `select public.reschedule_appointment_guarded(
        '${tenant}'::uuid, '${mover.appointmentId}'::uuid, 0,
        ${occupied}, 30, null, 'google_calendar', 'pending', now())`,
    );

    expect(failed.sqlState).toBe('23P01');

    // `calendar_desired_version` e' l'autorita' di scrittura verso Google:
    // se fosse avanzata, esisterebbe il permesso di proiettare un orario che
    // Postgres ha rifiutato di accettare.
    expect(desiredVersion(db, mover.appointmentId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function seedTenant(db: TestDatabase): string {
  const tenantId = randomUUID();

  db.exec(`
    insert into public.tenants (id, name, slug, billing_email)
    values ('${tenantId}', 'Studio Test', 'studio-${tenantId.slice(0, 8)}', 'billing@example.com');

    insert into public.integrations (tenant_id, provider, status, config)
    values ('${tenantId}', 'google_calendar', 'active', '{"calendar_id":"${CALENDAR_ID}"}'::jsonb);
  `);

  return tenantId;
}

function createSql(input: {
  tenantId: string;
  scheduledAt: string;
  appointmentId: string;
}): string {
  const eventId = `apt${input.appointmentId.replace(/-/g, '')}`;

  return `select public.create_appointment_with_calendar_intent(
    p_id := '${input.appointmentId}'::uuid,
    p_tenant_id := '${input.tenantId}'::uuid,
    p_expected_projection_epoch := 0,
    p_conversation_id := null,
    p_service_id := null,
    p_service_name := 'Prima visita',
    p_customer_identifier := '${PHONE}',
    p_customer_name := 'Mario Rossi',
    p_customer_phone := '${PHONE}',
    p_scheduled_at := ${input.scheduledAt},
    p_duration_minutes := 30,
    p_notes := null,
    p_booking_source := 'whatsapp_ai',
    p_calendar_provider := 'google_calendar',
    p_calendar_sync_status := 'pending',
    p_calendar_event_id := '${eventId}',
    p_calendar_sync_next_attempt_at := now(),
    p_calendar_target := '${CALENDAR_ID}',
    p_calendar_identity_source := 'current_config'
  )`;
}

type Created = { outcome: string; appointmentId: string; calendarEventId: string };

function createAppointment(
  db: TestDatabase,
  input: { tenantId: string; scheduledAt: string },
): Created {
  const appointmentId = randomUUID();
  const parsed = JSON.parse(db.scalar(createSql({ ...input, appointmentId })) ?? '{}') as Created;

  if (parsed.outcome !== 'created') {
    throw new Error(`create failed: ${parsed.outcome}`);
  }

  return parsed;
}

/** Esegue una creazione destinata a fallire e restituisce lo SQLSTATE. */
function attemptCreate(
  db: TestDatabase,
  input: { tenantId: string; scheduledAt: string },
): { sqlState: string | null; text: string } {
  return attempt(db, createSql({ ...input, appointmentId: randomUUID() }));
}

function attempt(db: TestDatabase, sql: string): { sqlState: string | null; text: string } {
  try {
    db.exec(sql);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);

    // psql riporta lo SQLSTATE solo con VERBOSITY verbose; il nome del vincolo
    // e' comunque nel testo, ed e' cio' che identifica il difetto.
    return {
      sqlState: /appointments_no_confirmed_overlap|23P01|conflicting key|exclusion/i.test(text)
        ? '23P01'
        : null,
      text,
    };
  }

  throw new Error('expected the statement to fail, but it succeeded');
}

function desiredVersion(db: TestDatabase, appointmentId: string): string {
  return (
    db.query<{ calendar_desired_version: string }>(
      `select calendar_desired_version from public.appointments where id = '${appointmentId}'`,
    )[0]?.calendar_desired_version ?? 'missing'
  );
}
