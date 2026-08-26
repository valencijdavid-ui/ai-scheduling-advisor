// Harness per i test su PostgreSQL reale (PILOT-P0-3A).
//
// I difetti che P0-3A chiude sono difetti di TRANSAZIONE e di FOREIGN KEY:
// un fake in memoria non li vede per costruzione. Il bug F3 e' stato scoperto
// solo eseguendo le migration vere su un Postgres vero, ed e' li' che va
// tenuto sotto controllo.
//
// Il database e' usa-e-getta: creato per il file di test, distrutto alla fine.
// Nessuna connessione a Supabase, nessun dato di produzione.
//
// Si parla con `psql` invece che con un driver: aggiungere una dipendenza
// runtime solo per i test allargherebbe la supply chain di produzione per un
// bisogno che vive interamente in locale.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MIGRATIONS_DIR = 'supabase/migrations';

/**
 * Superficie che Supabase fornisce e che le migration danno per scontata.
 * Non fa parte del contratto applicativo: serve solo a far girare le
 * migration vere su un Postgres nudo.
 */
const BOOTSTRAP_SQL = `
create extension if not exists pgcrypto;
create extension if not exists btree_gist;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid()
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', current_user)
$$;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
`;

/**
 * Concessioni che su Supabase esistono di default. Applicate DOPO le migration
 * perche' riguardano tabelle che le migration creano.
 */
const POST_MIGRATION_SQL = `
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Esegue uno statement e ritorna 'OK' oppure lo SQLSTATE dell'errore.
-- Serve a caratterizzare un fallimento SENZA abortire la sessione di test.
create or replace function public.harness_try(p_sql text) returns text
language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return SQLSTATE;
end
$$;
`;

export type TestDatabase = {
  readonly name: string;
  /** Esegue SQL senza risultato. Fallisce il test se lo statement fallisce. */
  exec(sql: string): void;
  /** Esegue una SELECT e ritorna le righe come oggetti. */
  query<T = Record<string, unknown>>(sql: string): T[];
  /** Ritorna un singolo valore scalare (o null). */
  scalar(sql: string): string | null;
  /** Esegue con un ruolo Postgres specifico (es. 'authenticated'). */
  execAs(role: string, sql: string): { ok: boolean; error: string };
  /**
   * Esegue lo statement catturando l'errore: ritorna 'OK' oppure lo SQLSTATE.
   * L'eventuale fallimento NON annulla il lavoro gia' committato prima.
   */
  trySql(sql: string): string;
  drop(): void;
};

export function postgresAvailable(): boolean {
  try {
    execFileSync('pg_isready', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Le migration del repository sono usate VERBATIM tranne un dettaglio che
 * dipende dall'ambiente e non dal comportamento sotto test:
 *
 * 1. l'estensione `vector` non esiste su un Postgres di serie. L'unica cosa
 *    che ne dipende e' l'embedding della knowledge base, che con la
 *    cancellazione non c'entra niente. L'indice hnsw si salta gia' da solo:
 *    la migration lo crea solo se l'estensione risulta installata.
 *
 * Il vincolo di esclusione `appointments_no_confirmed_overlap` era la seconda
 * deroga: la sua espressione non era indicizzabile e il blocco veniva saltato.
 * P0-7A l'ha riparata alla fonte, quindi la deroga e' sparita e il vincolo
 * viene ora applicato verbatim come tutto il resto.
 *
 * Tutto il resto — grafo delle FK, nomi dei vincoli, ON DELETE, RLS, funzioni,
 * grant — resta identico ai file del repository.
 */
function prepareMigrationSql(raw: string): string {
  return (
    raw
      .replace(
        /create extension if not exists "vector";/,
        '-- [harness] estensione vector non disponibile su postgres di serie',
      )
      .replace(/vector\(1536\)/g, 'text')
      // `<=>` e' l'operatore di distanza coseno di pgvector: senza l'estensione
      // non esiste, e il corpo di `match_knowledge_base` non compilerebbe.
      .replace(/kb\.embedding <=> p_query_embedding/g, '0::double precision')
  );
}

let sequence = 0;

export function createTestDatabase(): TestDatabase {
  sequence += 1;
  const name = `p03a_${process.pid}_${sequence}_${Date.now().toString(36)}`;
  const scratch = join(tmpdir(), `${name}.sql`);

  execFileSync('createdb', [name], { stdio: 'pipe' });

  const runFile = (sql: string): void => {
    writeFileSync(scratch, sql);
    try {
      execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-q', '-d', name, '-f', scratch], {
        stdio: 'pipe',
      });
    } finally {
      try {
        unlinkSync(scratch);
      } catch {
        // best-effort
      }
    }
  };

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => prepareMigrationSql(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')));

  // Se una migration non applica, il database va comunque buttato: altrimenti
  // ogni tentativo fallito lascia dietro di se' un database orfano, e chi
  // sviluppa se li ritrova accumulati senza sapere da dove vengano.
  try {
    runFile(BOOTSTRAP_SQL);
    for (const migration of migrations) {
      runFile(migration);
    }
    runFile(POST_MIGRATION_SQL);
  } catch (error) {
    try {
      execFileSync('dropdb', ['--if-exists', '--force', name], { stdio: 'pipe' });
    } catch {
      // Il fallimento originale e' quello che interessa.
    }

    throw error;
  }

  const capture = (sql: string): string =>
    execFileSync('psql', ['-v', 'ON_ERROR_STOP=1', '-tAq', '-d', name, '-c', sql], {
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();

  return {
    name,

    exec(sql: string): void {
      runFile(sql);
    },

    query<T = Record<string, unknown>>(sql: string): T[] {
      const raw = capture(`select coalesce(json_agg(t), '[]'::json) from (${sql}) t`);
      return JSON.parse(raw || '[]') as T[];
    },

    scalar(sql: string): string | null {
      const raw = capture(sql);
      return raw === '' ? null : raw;
    },

    execAs(role: string, sql: string): { ok: boolean; error: string } {
      try {
        execFileSync(
          'psql',
          ['-v', 'ON_ERROR_STOP=1', '-tAq', '-d', name, '-c', `set role ${role}; ${sql}`],
          { stdio: 'pipe', encoding: 'utf8' },
        );
        return { ok: true, error: '' };
      } catch (error) {
        const stderr = (error as { stderr?: Buffer | string }).stderr;
        return { ok: false, error: String(stderr ?? error) };
      }
    },

    trySql(sql: string): string {
      return capture(`select public.harness_try($harness$${sql}$harness$)`);
    },

    drop(): void {
      try {
        execFileSync('dropdb', ['--if-exists', '--force', name], { stdio: 'pipe' });
      } catch {
        // Un database di test che non si lascia cancellare non deve far
        // fallire una suite che ha gia' dato il suo verdetto.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Sessioni concorrenti (PILOT-P0-3C-i)
// ---------------------------------------------------------------------------
//
// Il fence dello scrittore e' una proprieta' di LOCK: due transazioni vere che
// si contendono la stessa riga di `tenants`. `execFileSync` non puo'
// dimostrarla — bloccherebbe il processo di test insieme alla query.
//
// Qui ogni sessione e' un `psql` interattivo vivo, con la propria transazione.
// L'attesa non e' una sleep: si osserva `pg_stat_activity` finche' il backend
// bloccato non dichiara di essere in attesa di un lock. Il test fallisce per
// timeout, mai per essere arrivato troppo presto.

/** Statement inviato a una sessione, ancora in corso o gia' concluso. */
export type PendingStatement = {
  readonly sql: string;
  readonly done: Promise<string>;
  /** `false` finche' Postgres non ha risposto: e' cosi' che si vede un blocco. */
  isSettled(): boolean;
};

export type PgSession = {
  /** PID del backend Postgres: serve a osservarne l'attesa da un'altra sessione. */
  readonly backendPid: number;
  /** Invia uno statement senza attenderlo. */
  send(sql: string): PendingStatement;
  /** Invia uno statement e ne attende l'esito. */
  run(sql: string): Promise<string>;
  close(): Promise<void>;
};

const STATEMENT_MARKER = '__P03C_STATEMENT_DONE__';
const DEFAULT_BLOCK_TIMEOUT_MS = 10_000;

export async function openSession(db: TestDatabase): Promise<PgSession> {
  const child: ChildProcess = spawn(
    'psql',
    ['-d', db.name, '-q', '-A', '-t', '--no-psqlrc', '-v', 'ON_ERROR_STOP=0'],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('psql session did not expose its pipes');
  }

  let buffer = '';
  const waiters: Array<{ resolve: (value: string) => void }> = [];

  const drain = (): void => {
    let index = buffer.indexOf(STATEMENT_MARKER);

    while (index !== -1) {
      const output = buffer.slice(0, index);
      buffer = buffer.slice(index + STATEMENT_MARKER.length);
      waiters.shift()?.resolve(output.trim());
      index = buffer.indexOf(STATEMENT_MARKER);
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    drain();
  });
  // stderr entra nello stesso flusso: un errore SQL e' un esito da asserire,
  // non un guasto del harness.
  child.stderr.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    drain();
  });

  const send = (sql: string): PendingStatement => {
    let settled = false;
    const done = new Promise<string>((resolve) => {
      waiters.push({
        resolve: (value) => {
          settled = true;
          resolve(value);
        },
      });
    });

    child.stdin?.write(`${sql}\n\\echo ${STATEMENT_MARKER}\n`);

    return { sql, done, isSettled: () => settled };
  };

  const run = (sql: string): Promise<string> => send(sql).done;

  const backendPid = Number((await run('select pg_backend_pid();')).trim());

  if (!Number.isInteger(backendPid) || backendPid <= 0) {
    throw new Error('psql session did not report a backend pid');
  }

  return {
    backendPid,
    send,
    run,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.stdin?.end('\\q\n');
        setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 2_000).unref();
      });
    },
  };
}

/**
 * Attende che un backend dichiari di essere in attesa di un LOCK.
 *
 * E' l'alternativa alla sleep: l'attesa termina su un fatto osservato in
 * `pg_stat_activity`, e il timeout e' un fallimento del test, non un caso
 * ammesso.
 */
export async function waitUntilBlockedOnLock(
  db: TestDatabase,
  backendPid: number,
  timeoutMs: number = DEFAULT_BLOCK_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = db.query<{ wait_event_type: string | null; state: string | null }>(
      `select wait_event_type, state from pg_stat_activity where pid = ${backendPid}`,
    );
    const row = rows[0];

    if (row?.wait_event_type === 'Lock') {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`backend ${backendPid} never blocked on a lock within ${timeoutMs}ms`);
}
