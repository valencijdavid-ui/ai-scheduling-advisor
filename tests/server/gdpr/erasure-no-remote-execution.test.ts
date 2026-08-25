// PILOT-P0-3A — confine di fase, verificato sul codice sorgente.
//
// P0-3A CATTURA il debito di cancellazione remota. NON lo esegue.
//
// E' una proprieta' che si perde in silenzio: basta che qualcuno colleghi un
// worker o un cron alla tabella delle obbligazioni e la fase comincia a
// cancellare eventi su Google senza che esista ancora il contratto di
// coordinamento con gli scrittori P0-1 (che arriva in P0-3C). Il rischio
// concreto e' cancellare un evento mentre uno scrittore in volo lo sta
// ricreando: il debito risulterebbe chiuso e l'evento — con dentro il telefono
// del cliente — resterebbe vivo.
//
// Questi test falliscono nel momento in cui quel collegamento viene creato.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const GOOGLE_WRITE_MARKERS = [
  'cancelEvent',
  'createEvent',
  'updateEvent',
  'GoogleCalendarProvider',
  '@/server/calendar/google',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return sourceFiles(full);
    }

    return full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : [];
  });
}

describe('PILOT-P0-3A — nessuna esecuzione remota', () => {
  it('nessun file che tocca le obbligazioni sa anche scrivere su Google', () => {
    const offenders = sourceFiles('src')
      .map((file) => ({ file, content: readFileSync(file, 'utf8') }))
      .filter(({ content }) => content.includes('erasure_obligations'))
      .filter(({ content }) => GOOGLE_WRITE_MARKERS.some((marker) => content.includes(marker)))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it('il modulo di cancellazione GDPR non conosce il provider Google', () => {
    const content = readFileSync('src/server/gdpr/data-delete.ts', 'utf8');

    for (const marker of GOOGLE_WRITE_MARKERS) {
      expect(content).not.toContain(marker);
    }

    // Nessuna rete di nessun tipo da questo percorso.
    expect(content).not.toContain('fetch(');
  });

  it('non esiste un cron che converge le obbligazioni', () => {
    const vercel = readFileSync('vercel.json', 'utf8');
    const crons = (JSON.parse(vercel) as { crons: Array<{ path: string }> }).crons;

    expect(crons.some((cron) => cron.path.includes('erasure'))).toBe(false);
    expect(crons.some((cron) => cron.path.includes('obligation'))).toBe(false);
  });

  it('nessuna route interna espone la convergenza remota', () => {
    const routes = sourceFiles('src/app/api').filter((file) =>
      readFileSync(file, 'utf8').includes('erasure_obligations'),
    );

    expect(routes).toEqual([]);
  });

  it('la transazione SQL non contiene nessuna chiamata di rete', () => {
    const migration = readFileSync(
      'supabase/migrations/202608250001_erasure_obligations.sql',
      'utf8',
    );

    // Postgres puo' uscire in rete solo con estensioni dedicate: nessuna deve
    // comparire qui. Una chiamata HTTP dentro la transazione la terrebbe
    // aperta per tutta la durata della richiesta remota.
    for (const marker of ['http_get', 'http_post', 'net.http', 'pg_net', 'dblink']) {
      expect(migration).not.toContain(marker);
    }
  });

  it('la tabella non ha nessuna colonna capace di contenere credenziali o PII', () => {
    const migration = readFileSync(
      'supabase/migrations/202608250001_erasure_obligations.sql',
      'utf8',
    );
    const table = migration.slice(
      migration.indexOf('create table if not exists public.erasure_obligations'),
      migration.indexOf('comment on table public.erasure_obligations'),
    );

    for (const forbidden of [
      'access_token',
      'refresh_token',
      'credential',
      'customer_phone',
      'customer_name',
      'customer_identifier',
      'email',
      'notes',
      'content',
    ]) {
      expect(table).not.toContain(forbidden);
    }
  });
});
