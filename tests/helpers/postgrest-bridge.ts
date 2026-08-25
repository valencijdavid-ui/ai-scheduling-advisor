// PILOT-P0-3C — ponte PostgREST -> PostgreSQL reale, per i test di
// caratterizzazione della concorrenza.
//
// PERCHE' ESISTE
//
// I difetti che P0-3C deve chiudere vivono nel CONTEGGIO DELLE RIGHE TOCCATE:
// un UPDATE che non trova nulla non e' un errore per Postgres, e non lo e'
// nemmeno per PostgREST. Un fake che restituisse `{ error: null }` a comando
// dimostrerebbe solo che il fake e' stato scritto cosi'.
//
// Qui la fluent API di supabase-js viene TRADOTTA in SQL ed eseguita su un
// database usa-e-getta con le migration vere. Il numero di righe toccate lo
// decide Postgres, non questo file.
//
// L'UNICA cosa modellata e non eseguita e' il contratto di ritorno di
// supabase-js:
//
//   - `.update(...).eq(...)` atteso SENZA `.select()`  -> { data: null, error: null }
//     (PostgREST risponde 204 No Content: il conteggio non attraversa il
//      confine, ed e' esattamente il difetto sotto esame)
//   - `.update(...).eq(...).select(cols)`              -> { data: righe, error: null }
//
// Per non doversi fidare di quella modellazione sulla parola, ogni chiamata
// registra in `calls` il conteggio REALE delle righe toccate, letto da
// `RETURNING`. Un test puo' quindi affermare insieme:
//
//   - Postgres ha toccato zero righe   (verita' del database)
//   - il repository non ha visto niente (contratto del confine)
//
// SUPERFICIE
//
// Deliberatamente minima: solo cio' che i repository sotto caratterizzazione
// costruiscono davvero. Non e' un'emulazione di supabase-js e non deve
// diventarlo.

import type { TestDatabase } from './postgres';

export type BridgeCall = {
  table: string;
  verb: 'select' | 'update';
  /** `true` solo se il chiamante ha chiesto indietro le righe con `.select()`. */
  selectRequested: boolean;
  /** Righe REALMENTE toccate/lette, secondo Postgres. */
  affectedRows: number;
  sql: string;
};

type SupabaseResult<T> = { data: T; error: { code?: string; message?: string } | null };

export type PostgrestBridge = {
  /** Client da iniettare al posto di `createSupabaseAdminClient()`. */
  readonly client: { from(table: string): FromBuilder };
  /** Registro di cio' che e' stato costruito ed eseguito. */
  readonly calls: BridgeCall[];
  reset(): void;
};

type FromBuilder = {
  select(columns?: string): FilterBuilder;
  update(patch: Record<string, unknown>): FilterBuilder;
};

type FilterBuilder = {
  eq(column: string, value: unknown): FilterBuilder;
  in(column: string, values: readonly unknown[]): FilterBuilder;
  not(column: string, operator: string, value: unknown): FilterBuilder;
  lte(column: string, value: unknown): FilterBuilder;
  lt(column: string, value: unknown): FilterBuilder;
  gt(column: string, value: unknown): FilterBuilder;
  order(column: string, options?: { ascending?: boolean }): FilterBuilder;
  limit(count: number): FilterBuilder;
  select(columns?: string): FilterBuilder;
  maybeSingle(): Promise<SupabaseResult<Record<string, unknown> | null>>;
  single(): Promise<SupabaseResult<Record<string, unknown> | null>>;
  then<TResult1 = SupabaseResult<Record<string, unknown>[] | null>, TResult2 = never>(
    onfulfilled?:
      | ((
          value: SupabaseResult<Record<string, unknown>[] | null>,
        ) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2>;
};

/** Letterale SQL. I valori dei test sono controllati: basta l'escape standard. */
function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (value instanceof Date) {
    return `'${value.toISOString()}'`;
  }

  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }

  return `'${String(value).replace(/'/g, "''")}'`;
}

export function createPostgrestBridge(db: TestDatabase): PostgrestBridge {
  const calls: BridgeCall[] = [];

  function buildFilterBuilder(
    table: string,
    verb: 'select' | 'update',
    patch: Record<string, unknown> | null,
    initialColumns: string | null,
  ): FilterBuilder {
    const filters: string[] = [];
    let orderSql = '';
    let limitSql = '';
    // Per una SELECT le colonne arrivano subito; per un UPDATE solo se il
    // chiamante chiede `.select()` — ed e' precisamente quella differenza che
    // questi test caratterizzano.
    let columns: string | null = initialColumns;
    let selectRequested = verb === 'select';

    const run = (): { rows: Record<string, unknown>[]; sql: string } => {
      const where = filters.length > 0 ? ` where ${filters.join(' and ')}` : '';
      let rows: Record<string, unknown>[];
      let sql: string;

      if (verb === 'update') {
        const sets = Object.entries(patch ?? {})
          .map(([column, value]) => `${column} = ${literal(value)}`)
          .join(', ');
        // `returning` c'e' SEMPRE: serve al registro del ponte per conoscere
        // la verita' di Postgres. Cio' che il chiamante riceve dipende invece
        // da `selectRequested`, sotto.
        //
        // Una CTE che modifica dati deve stare al livello piu' esterno, quindi
        // qui l'aggregazione JSON e' costruita a mano invece di riusare
        // `db.query`, che avvolge lo statement in una sottoquery.
        sql = `with __bridge as (update public.${table} set ${sets}${where} returning ${
          columns ?? 'id'
        }) select coalesce(json_agg(__bridge), '[]'::json) from __bridge`;
        rows = JSON.parse(db.scalar(sql) ?? '[]') as Record<string, unknown>[];
      } else {
        sql = `select ${columns ?? '*'} from public.${table}${where}${orderSql}${limitSql}`;
        rows = db.query<Record<string, unknown>>(sql);
      }

      calls.push({ table, verb, selectRequested, affectedRows: rows.length, sql });

      return { rows, sql };
    };

    const builder: FilterBuilder = {
      eq(column, value) {
        filters.push(value === null ? `${column} is null` : `${column} = ${literal(value)}`);
        return builder;
      },
      in(column, values) {
        const list = values.length > 0 ? values.map(literal).join(', ') : 'null';
        filters.push(`${column} in (${list})`);
        return builder;
      },
      not(column, operator, value) {
        if (operator === 'is' && value === null) {
          filters.push(`${column} is not null`);
        } else {
          filters.push(`not (${column} ${operator} ${literal(value)})`);
        }
        return builder;
      },
      lte(column, value) {
        filters.push(`${column} <= ${literal(value)}`);
        return builder;
      },
      lt(column, value) {
        filters.push(`${column} < ${literal(value)}`);
        return builder;
      },
      gt(column, value) {
        filters.push(`${column} > ${literal(value)}`);
        return builder;
      },
      order(column, options = {}) {
        orderSql = ` order by ${column} ${options.ascending === false ? 'desc' : 'asc'}`;
        return builder;
      },
      limit(count) {
        limitSql = ` limit ${Math.trunc(count)}`;
        return builder;
      },
      select(nextColumns = '*') {
        columns = nextColumns;
        selectRequested = true;
        return builder;
      },
      async maybeSingle() {
        const { rows } = run();
        return { data: rows[0] ?? null, error: null };
      },
      async single() {
        const { rows } = run();

        if (rows.length !== 1) {
          return {
            data: null,
            error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows' },
          };
        }

        return { data: rows[0] ?? null, error: null };
      },
      then(onfulfilled, onrejected) {
        return (async (): Promise<SupabaseResult<Record<string, unknown>[] | null>> => {
          const { rows } = run();

          // IL PUNTO DI TUTTO IL FILE.
          //
          // Senza `.select()` PostgREST risponde 204 No Content: supabase-js
          // consegna `{ data: null, error: null }` e il conteggio delle righe
          // non attraversa il confine. Zero righe e una riga sono lo stesso
          // valore per il chiamante.
          return selectRequested ? { data: rows, error: null } : { data: null, error: null };
        })().then(onfulfilled ?? null, onrejected ?? null);
      },
    };

    return builder;
  }

  return {
    calls,
    client: {
      from(table: string): FromBuilder {
        return {
          select(columns = '*') {
            return buildFilterBuilder(table, 'select', null, columns);
          },
          update(patch: Record<string, unknown>) {
            return buildFilterBuilder(table, 'update', patch, null);
          },
        };
      },
    },
    reset(): void {
      calls.length = 0;
    },
  };
}
