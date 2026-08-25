// PILOT-P0-7A — protezione contro appuntamenti sovrapposti, su PostgreSQL reale.
//
// La migration iniziale definiva una exclusion constraint la cui espressione
// non era indicizzabile: `timestamptz + interval` e' STABLE, e PostgreSQL
// rifiuta l'ALTER con SQLSTATE 42P17. Il difetto ha prodotto due popolazioni
// diverse, e questi test verificano che convergano sullo stesso schema:
//
//   F1  database nuovo: l'intera catena di migration applica, vincolo incluso;
//   F2  database gia' dispiegato (registro «applicata», vincolo assente):
//       la migration additiva installa la stessa protezione.
//
// Il resto dei casi (F3-F8) fissa la semantica che il vincolo originale
// intendeva e che la riparazione non deve alterare.
//
// Se non c'e' un PostgreSQL locale la suite si salta invece di fallire: non
// deve rompere `npm run verify` su una macchina senza database.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDatabase, postgresAvailable, type TestDatabase } from '../../helpers/postgres';

const HAS_POSTGRES = postgresAvailable();
const describePg = HAS_POSTGRES ? describe : describe.skip;

const CONSTRAINT = 'appointments_no_confirmed_overlap';
const REPAIR_MIGRATION = 'supabase/migrations/202608250002_appointment_overlap_repair.sql';

const BASE = '2026-09-14T09:00:00Z';

/** Istante ISO spostato di `minutes` rispetto a `BASE`. */
function at(minutes: number): string {
  return new Date(Date.parse(BASE) + minutes * 60_000).toISOString();
}

function constraintDefinition(db: TestDatabase): string | null {
  return db.scalar(
    `select pg_get_constraintdef(oid) from pg_constraint where conname = '${CONSTRAINT}'`,
  );
}

/**
 * Definizione dell'indice GiST che regge il vincolo. Il vincolo senza il suo
 * indice non protegge niente: il difetto originale era proprio il rifiuto di
 * costruire quell'indice.
 */
function backingIndexDefinition(db: TestDatabase): string | null {
  return db.scalar(
    `select pg_get_indexdef(c.conindid)
     from pg_constraint c
     where c.conname = '${CONSTRAINT}'
       and c.conrelid = 'public.appointments'::regclass
       and c.conindid <> 0`,
  );
}

function seedTenant(db: TestDatabase): string {
  const id = randomUUID();
  const slug = `p07a-${id.slice(0, 8)}`;

  db.exec(
    `insert into public.tenants (id, name, slug, billing_email)
     values ('${id}', 'P0-7A', '${slug}', 'p07a@example.com');`,
  );

  return id;
}

function insertAppointment(
  db: TestDatabase,
  input: {
    tenantId: string;
    scheduledAt: string;
    durationMinutes: number;
    status?: string;
    id?: string;
  },
): string {
  const id = input.id ?? randomUUID();

  db.exec(
    `insert into public.appointments
       (id, tenant_id, customer_identifier, customer_name, scheduled_at, duration_minutes, status)
     values
       ('${id}', '${input.tenantId}', 'cust', 'Cliente',
        '${input.scheduledAt}', ${input.durationMinutes}, '${input.status ?? 'confirmed'}');`,
  );

  return id;
}

/** Come `insertAppointment`, ma ritorna lo SQLSTATE invece di far fallire. */
function tryInsertAppointment(
  db: TestDatabase,
  input: { tenantId: string; scheduledAt: string; durationMinutes: number; status?: string },
): string {
  return db.trySql(
    `insert into public.appointments
       (tenant_id, customer_identifier, customer_name, scheduled_at, duration_minutes, status)
     values
       ('${input.tenantId}', 'cust', 'Cliente',
        '${input.scheduledAt}', ${input.durationMinutes}, '${input.status ?? 'confirmed'}')`,
  );
}

/**
 * Riporta il database alla forma di un'installazione gia' dispiegata: la
 * migration iniziale risulta applicata, le successive sono passate, ma la
 * protezione non e' mai esistita perche' il suo ALTER era stato rifiutato.
 *
 * Si smonta anche la funzione, non solo il vincolo: su quelle installazioni
 * non e' mai stata creata, e la migration additiva deve saperla portare.
 */
function degradeToDeployedShape(db: TestDatabase): void {
  db.exec(`alter table public.appointments drop constraint if exists ${CONSTRAINT};`);
  db.exec(`drop function if exists public.appointment_slot_range(timestamptz, integer);`);
}

function applyRepairMigration(db: TestDatabase): void {
  db.exec(readFileSync(REPAIR_MIGRATION, 'utf8'));
}

function applyRepairMigrationCapturingError(db: TestDatabase): string {
  try {
    applyRepairMigration(db);
    return '';
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string }).stderr;
    return String(stderr ?? error);
  }
}

describePg('PILOT-P0-7A — appointments_no_confirmed_overlap su Postgres reale', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  }, 120_000);

  afterAll(() => {
    db?.drop();
  });

  // -------------------------------------------------------------------------
  // Convergenza delle due popolazioni
  // -------------------------------------------------------------------------

  it('F1: un database nato dalla catena completa ha la protezione', () => {
    // `createTestDatabase` applica ogni file di `supabase/migrations` in
    // ordine. Che sia arrivato fino a qui e' gia' meta' del verdetto: prima
    // della riparazione la migration iniziale abortiva a questo statement e
    // nessuna delle successive partiva.
    const definition = constraintDefinition(db);

    expect(definition).not.toBeNull();
    expect(definition).toContain('EXCLUDE USING gist');
    expect(definition).toContain('tenant_id WITH =');
    expect(definition).toContain('appointment_slot_range(scheduled_at, duration_minutes) WITH &&');
    expect(definition).toContain(`WHERE ((status = 'confirmed'::text))`);

    const index = backingIndexDefinition(db);
    expect(index).not.toBeNull();
    expect(index).toContain('USING gist');
  });

  it("F2: un database gia' dispiegato riceve la stessa identica protezione", () => {
    const fresh = constraintDefinition(db);
    const freshIndex = backingIndexDefinition(db);

    degradeToDeployedShape(db);
    expect(constraintDefinition(db)).toBeNull();
    expect(backingIndexDefinition(db)).toBeNull();

    applyRepairMigration(db);

    // Stessa definizione, carattere per carattere: le due popolazioni non
    // convergono «piu' o meno», convergono sullo stesso schema.
    expect(constraintDefinition(db)).toBe(fresh);
    expect(backingIndexDefinition(db)).toBe(freshIndex);
  });

  it("F2b: la migration additiva e' un no-op su un database gia' sano", () => {
    const before = constraintDefinition(db);

    applyRepairMigration(db);

    expect(constraintDefinition(db)).toBe(before);
  });

  it('F2c: sovrapposizioni preesistenti fermano la migration con una diagnosi', () => {
    const tenantId = seedTenant(db);

    degradeToDeployedShape(db);

    // Senza vincolo queste due righe entrano: e' esattamente il danno che le
    // installazioni dispiegate hanno potuto accumulare.
    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 });
    insertAppointment(db, { tenantId, scheduledAt: at(30), durationMinutes: 60 });

    const stderr = applyRepairMigrationCapturingError(db);

    expect(stderr).toContain(CONSTRAINT);
    expect(stderr).toContain('sovrapposti');
    // Il conteggio e' totale, non troncato al campione.
    expect(stderr).toContain('esistono 1 coppie');
    expect(constraintDefinition(db)).toBeNull();

    // Rimosso il conflitto, la stessa migration completa senza modifiche.
    db.exec(
      `delete from public.appointments where tenant_id = '${tenantId}' and scheduled_at = '${at(30)}';`,
    );
    applyRepairMigration(db);

    expect(constraintDefinition(db)).not.toBeNull();

    db.exec(`delete from public.appointments where tenant_id = '${tenantId}';`);
  });

  // -------------------------------------------------------------------------
  // Semantica protetta
  // -------------------------------------------------------------------------

  it('F3: due appuntamenti confermati che non si toccano sono accettati', () => {
    const tenantId = seedTenant(db);

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 30 });

    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(60), durationMinutes: 30 })).toBe(
      'OK',
    );
  });

  it('F4: due appuntamenti confermati sovrapposti sono rifiutati', () => {
    const tenantId = seedTenant(db);

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 });

    // exclusion_violation.
    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(30), durationMinutes: 60 })).toBe(
      '23P01',
    );

    // Contenimento totale e coincidenza esatta sono sovrapposizioni anche loro.
    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(10), durationMinutes: 5 })).toBe(
      '23P01',
    );
    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 })).toBe(
      '23P01',
    );
  });

  it("F5: il confine e' half-open — consecutivi che si toccano non confliggono", () => {
    const tenantId = seedTenant(db);

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 30 });

    // La fine del primo coincide con l'inizio del secondo: `[)` lo consente,
    // ed e' la semantica del vincolo originale. Cambiarla vieterebbe l'agenda
    // fitta, che e' il caso normale di uno studio.
    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(30), durationMinutes: 30 })).toBe(
      'OK',
    );

    // Un solo minuto prima della fine e' invece sovrapposizione.
    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(29), durationMinutes: 30 })).toBe(
      '23P01',
    );
  });

  it('F6: il vincolo vale solo per le righe confermate', () => {
    const tenantId = seedTenant(db);

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 });

    for (const status of ['cancelled', 'completed', 'no_show']) {
      expect(
        tryInsertAppointment(db, { tenantId, scheduledAt: at(30), durationMinutes: 60, status }),
      ).toBe('OK');
    }

    // Le righe non confermate non si vincolano nemmeno fra loro.
    expect(
      tryInsertAppointment(db, {
        tenantId,
        scheduledAt: at(30),
        durationMinutes: 60,
        status: 'cancelled',
      }),
    ).toBe('OK');
  });

  it('F7: tenant diversi non confliggono sullo stesso istante', () => {
    const first = seedTenant(db);
    const second = seedTenant(db);

    insertAppointment(db, { tenantId: first, scheduledAt: at(0), durationMinutes: 60 });

    expect(
      tryInsertAppointment(db, { tenantId: second, scheduledAt: at(0), durationMinutes: 60 }),
    ).toBe('OK');
  });

  it("F8: uno spostamento dentro una sovrapposizione e' rifiutato", () => {
    const tenantId = seedTenant(db);

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 });
    const moving = insertAppointment(db, { tenantId, scheduledAt: at(120), durationMinutes: 60 });

    // Il difetto non e' solo all'INSERT: senza vincolo un reschedule poteva
    // scavalcare qualunque controllo applicativo fatto prima della scrittura.
    expect(
      db.trySql(`update public.appointments set scheduled_at = '${at(30)}' where id = '${moving}'`),
    ).toBe('23P01');

    // Anche allungare la durata dentro il vicino e' uno spostamento.
    expect(
      db.trySql(
        `update public.appointments set scheduled_at = '${at(60)}', duration_minutes = 120 where id = '${moving}'`,
      ),
    ).toBe('OK');

    expect(
      db.trySql(`update public.appointments set duration_minutes = 300 where id = '${moving}'`),
    ).toBe('OK');

    // Riportare una riga annullata a 'confirmed' sopra un'altra e' rifiutato:
    // il predicato parziale la fa rientrare nel vincolo.
    const revived = insertAppointment(db, {
      tenantId,
      scheduledAt: at(15),
      durationMinutes: 30,
      status: 'cancelled',
    });

    expect(
      db.trySql(`update public.appointments set status = 'confirmed' where id = '${revived}'`),
    ).toBe('23P01');
  });

  // -------------------------------------------------------------------------
  // Proprieta' dell'espressione indicizzata
  // -------------------------------------------------------------------------

  it("l'espressione e' dichiarata IMMUTABLE e lo e' davvero", () => {
    // `provolatile = 'i'`: senza questo l'ALTER torna a fallire con 42P17.
    expect(
      db.scalar(`select provolatile from pg_proc where proname = 'appointment_slot_range'`),
    ).toBe('i');

    // La dichiarazione non e' una bugia detta al pianificatore: il risultato
    // e' lo stesso istante in fusi diversi, attraversamento di ora legale
    // incluso. `make_interval(mins => n)` non produce mai giorni o mesi, che
    // sono l'unica ragione per cui `timestamptz + interval` e' STABLE.
    //
    // L'istante scelto e' 90 minuti a cavallo del cambio di ora legale
    // europeo del 2026: se l'espressione dipendesse dal TimeZone di sessione,
    // e' li' che si vedrebbe.
    const epochs = ['UTC', 'Europe/Rome', 'Pacific/Kiritimati', 'America/Santiago'].map((zone) =>
      db.scalar(
        `set timezone = '${zone}';
         select extract(epoch from upper(public.appointment_slot_range(
                  timestamptz '2026-03-29 01:30:00+00', 90)))::text`,
      ),
    );

    expect(new Set(epochs).size).toBe(1);
    // 2026-03-29T01:30:00Z + 90 minuti = 2026-03-29T03:00:00Z.
    expect(epochs[0]).toBe(String(Date.parse('2026-03-29T03:00:00Z') / 1000) + '.000000');
  });

  it('un UPDATE che non tocca lo slot non entra in conflitto con se stesso', () => {
    const tenantId = seedTenant(db);
    const appointmentId = insertAppointment(db, {
      tenantId,
      scheduledAt: at(0),
      durationMinutes: 60,
    });

    // Forma esatta della scrittura che P0-3C-i fa per autorizzare una
    // mutazione remota: bumpa una colonna di bookkeeping su una riga
    // confermata, senza toccare `scheduled_at`, `duration_minutes`, `status`
    // ne' `tenant_id`.
    //
    // Se il vincolo vedesse la nuova versione della tupla come un intruso
    // rispetto alla vecchia, ogni singolo settle fallirebbe con 23P01 e la
    // riparazione avrebbe rotto il writer invece di proteggerlo.
    expect(
      db.trySql(`update public.appointments set updated_at = now() where id = '${appointmentId}'`),
    ).toBe('OK');

    expect(
      db.trySql(
        `update public.appointments set calendar_sync_attempts = calendar_sync_attempts + 1 where id = '${appointmentId}'`,
      ),
    ).toBe('OK');

    // Ripetuto: anche dopo piu' versioni della stessa riga.
    for (let i = 0; i < 5; i += 1) {
      expect(
        db.trySql(
          `update public.appointments set calendar_sync_attempts = calendar_sync_attempts + 1 where id = '${appointmentId}'`,
        ),
      ).toBe('OK');
    }
  });

  it('una durata non positiva resta fuori dal vincolo invece di farlo esplodere', () => {
    const tenantId = seedTenant(db);

    // `appointments.duration_minutes` non ha un check di positivita'. Senza la
    // clausola `greatest` nell'espressione, `tstzrange` esploderebbe con
    // lower > upper e il vincolo rifiuterebbe righe che il database accettava.
    expect(
      db.scalar(
        `select isempty(public.appointment_slot_range(timestamptz '2026-09-14 09:00:00+00', 0))`,
      ),
    ).toBe('t');
    expect(
      db.scalar(
        `select isempty(public.appointment_slot_range(timestamptz '2026-09-14 09:00:00+00', -30))`,
      ),
    ).toBe('t');

    insertAppointment(db, { tenantId, scheduledAt: at(0), durationMinutes: 60 });

    expect(tryInsertAppointment(db, { tenantId, scheduledAt: at(30), durationMinutes: 0 })).toBe(
      'OK',
    );
  });
});
