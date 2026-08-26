// Fatto da Claude Code il 24 agosto 2026.
//
// Convergenza della proiezione Google Calendar.
//
// Il difetto che questo modulo esiste per eliminare: ogni percorso di
// scrittura (create, reschedule, cancel) chiamava Google a modo suo, una
// volta sola, sul filo dell'azione. Se quella singola chiamata falliva, o se
// falliva la scrittura DB che ne registrava l'esito, il sistema restava con
// un appuntamento reale in Postgres e una proiezione remota sbagliata, senza
// nessuno che ci tornasse sopra.
//
// Qui l'approccio e' rovesciato ed e' UNO SOLO per tutti i chiamanti:
//
// - Postgres e' la sorgente di verita': esistenza, orario, stato.
// - Google e' una proiezione derivata.
// - La convergenza non "riesegue le azioni" (crea/sposta/annulla): legge lo
//   stato desiderato ADESSO e porta l'evento remoto a coincidere.
//
// La differenza e' sostanziale. Rieseguire le azioni obbliga a conservare
// una storia ordinata e a preoccuparsi di quante volte ciascuna viene
// applicata. Convergere verso lo stato corrente e' idempotente per
// costruzione: due riprogrammazioni consecutive prima di un tick del cron
// lasciano in Google solo l'ultima, perche' l'ultima e' l'unica che esiste
// in Postgres quando la convergenza gira.
//
// L'ordine di convergenza e' GET-first, non insert-first. Google documenta
// che il rilevamento delle collisioni di id "non e' garantito al momento
// della creazione" per via della distribuzione globale del servizio: un
// design che si affida al 409 per non duplicare si appoggia a una garanzia
// che il fornitore non da'. Leggere prima e creare solo su 404 toglie di
// mezzo quella dipendenza; il 409 resta gestito come rete di sicurezza.

import { AppError } from '@/lib/errors/app-error';
import { createCalendarWriteBudget } from '@/server/calendar/google';
import type {
  CalendarWriteBudget,
  GoogleCalendarDeleteOutcome,
  GoogleCalendarEventResult,
  GoogleCalendarEventSnapshot,
  GoogleCalendarIntegration,
} from '@/server/calendar/google';

/**
 * Tentativi totali prima che una riga diventi terminale.
 *
 * Con il backoff sotto, cinque tentativi coprono circa 75 minuti: abbastanza
 * per assorbire un guasto transitorio di Google, poco abbastanza da mettere
 * l'operatore davanti al problema mentre l'appuntamento e' ancora spostabile.
 */
export const CALENDAR_SYNC_MAX_ATTEMPTS = 5;

/** Cadenza del cron di riconciliazione: il backoff e' un multiplo di questo. */
export const CALENDAR_SYNC_TICK_MS = 5 * 60_000;

/** Tetto del backoff: oltre un'ora rinviare ancora non aiuta nessuno. */
export const CALENDAR_SYNC_MAX_BACKOFF_MS = 12 * CALENDAR_SYNC_TICK_MS;

/**
 * Durata del lease preso da chi rivendica una riga.
 *
 * Se il worker muore a meta' lavoro la riga torna eleggibile da sola dopo un
 * tick: non serve nessun processo di sblocco.
 */
export const CALENDAR_SYNC_LEASE_MS = CALENDAR_SYNC_TICK_MS;

/**
 * Finestra entro cui un appuntamento non sincronizzato e' urgente.
 *
 * Sotto le 24 ore l'operatore non ha piu' il tempo di accorgersene da solo:
 * il primo fallimento deve gia' essere visibile.
 */
export const CALENDAR_SYNC_URGENT_WINDOW_MS = 24 * 60 * 60_000;

/**
 * Prefisso degli id derivati.
 *
 * Serve a distinguere a colpo d'occhio, in un calendario, gli eventi la cui
 * identita' e' derivata dall'appuntamento da quelli storici con id generato
 * da Google. L'alfabeto ammesso da Google per gli id forniti dal chiamante e'
 * base32hex (`0-9`, `a-v`): `apt` e le 32 cifre esadecimali di un UUID sono
 * tutte dentro quell'alfabeto, e 35 caratteri stanno nel limite 5-1024.
 */
const DERIVED_EVENT_ID_PREFIX = 'apt';

const UUID_HEX_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Identita' Google derivata dall'id dell'appuntamento.
 *
 * Funzione totale e deterministica: lo stesso appuntamento produce sempre lo
 * stesso id, quindi un insert ripetuto e' un conflitto e non un duplicato.
 *
 * Il valore prodotto qui viene persistito nell'insert dell'appuntamento e da
 * quel momento e' la colonna `calendar_event_id` a comandare: questa funzione
 * genera l'identita', non la ricalcola a ogni uso. E' la distinzione che
 * tiene al sicuro le righe storiche, che hanno id casuali generati da Google
 * e che devono continuare a operare sui propri.
 */
export function deriveCalendarEventId(appointmentId: string): string {
  const normalized = appointmentId.trim().toLowerCase().replace(/-/g, '');

  if (!UUID_HEX_PATTERN.test(normalized)) {
    throw new AppError(
      'internal',
      'Cannot derive a Google Calendar event id from a non-UUID appointment id',
      { expose: false },
    );
  }

  return `${DERIVED_EVENT_ID_PREFIX}${normalized}`;
}

/**
 * Prossimo tentativo, espresso in multipli del tick del cron.
 *
 * Ritardi che non sono multipli della cadenza dello scanner sono una finzione:
 * la riga verrebbe comunque presa al tick successivo. Ragionare in tick rende
 * il backoff verificabile a mente e nei test.
 */
export function calculateCalendarSyncNextAttemptAt(now: Date, attempts: number): Date {
  const normalizedAttempts = Math.max(1, attempts);
  const delayMs = Math.min(
    CALENDAR_SYNC_MAX_BACKOFF_MS,
    CALENDAR_SYNC_TICK_MS * 2 ** Math.min(normalizedAttempts - 1, 10),
  );

  return new Date(now.getTime() + delayMs);
}

/**
 * Errori per cui ritentare e' solo rumore.
 *
 * Credenziali non valide (401) o payload rifiutato (400) non guariscono col
 * tempo: consumare cinque tentativi prima di dirlo all'operatore ritarda
 * l'unica cosa che risolve, cioe' un intervento umano.
 *
 * Il 403 NON e' in questa lista, e non e' una dimenticanza. Google lo usa sia
 * per i permessi mancanti sia per `rateLimitExceeded` e
 * `userRateLimitExceeded`, che sono per definizione temporanei. Trattarlo come
 * definitivo trasformerebbe un limite di frequenza — cioe' esattamente la
 * situazione per cui il backoff esiste — in uno stato terminale che richiede
 * un intervento umano. Meglio spendere il budget dei tentativi su un permesso
 * davvero revocato che dichiarare irreparabile un rallentamento passeggero:
 * il primo caso diventa comunque terminale un'ora dopo, il secondo si
 * risolverebbe da solo e non ne avrebbe mai avuto bisogno.
 */
export function isNonRetryableCalendarError(error: unknown): boolean {
  const status = googleStatusOf(error);

  if (status === 400 || status === 401) {
    return true;
  }

  return error instanceof AppError && error.code === 'bad_request';
}

/** Stato HTTP dell'errore Google, quando il provider lo ha conservato. */
export function googleStatusOf(error: unknown): number | null {
  if (!(error instanceof AppError)) {
    return null;
  }

  const cause: unknown = error.cause;

  if (
    typeof cause === 'object' &&
    cause !== null &&
    'status' in cause &&
    typeof cause.status === 'number'
  ) {
    return cause.status;
  }

  return null;
}

/**
 * Porta minima verso Google richiesta dalla convergenza.
 *
 * `GoogleCalendarProvider` la soddisfa; i test la implementano in memoria.
 */
export type CalendarConvergenceProvider = {
  getEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
    budget?: CalendarWriteBudget;
  }): Promise<GoogleCalendarEventSnapshot | null>;
  createEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId?: string;
    budget?: CalendarWriteBudget;
    appointmentId: string;
    tenantId: string;
    summary: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    timezone: string;
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
  }): Promise<GoogleCalendarEventResult>;
  updateEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
    budget?: CalendarWriteBudget;
    appointmentId: string;
    tenantId: string;
    summary: string;
    description?: string;
    location?: string;
    start: Date;
    end: Date;
    timezone: string;
    customerName: string;
    customerPhone?: string | null;
    customerEmail?: string | null;
    status?: string;
  }): Promise<GoogleCalendarEventResult>;
  cancelEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
    budget?: CalendarWriteBudget;
  }): Promise<GoogleCalendarDeleteOutcome>;
};

/**
 * Stato desiderato: la riga Postgres tradotta in termini di evento.
 *
 * Non contiene nulla di storico. E' una fotografia del presente, ed e'
 * l'unico input della convergenza oltre all'integrazione del tenant.
 */
export type CalendarConvergenceTarget = {
  tenantId: string;
  appointmentId: string;
  /** Identita' operativa: il valore persistito, mai ricalcolato. */
  eventId: string;
  /**
   * Provenienza VERIFICATA dell'evento, quando esiste.
   *
   * Governa GET, PATCH e DELETE: un evento gia' scritto va raggiunto dove vive
   * davvero. Assente significa "non lo sappiamo ancora" — e allora si usa il
   * calendario configurato adesso, che pero' resta un'ipotesi, non una prova.
   */
  calendarId?: string | null;
  status: 'confirmed' | 'cancelled';
  start: Date;
  end: Date;
  timezone: string;
  summary: string;
  description?: string;
  location?: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
};

export type CalendarConvergenceAction =
  | 'unchanged'
  | 'patched'
  | 'inserted'
  | 'deleted'
  | 'already_absent';

export type CalendarConvergenceResult = {
  eventId: string;
  htmlLink: string | null;
  action: CalendarConvergenceAction;
  /**
   * Calendario CONTATTATO DAVVERO da questa operazione.
   *
   * Va propagato fino al settle e persistito li', nella stessa transazione che
   * registra l'esito. Ricostruirlo dopo rileggendo la configurazione
   * significherebbe dedurre una verita' storica da un valore mutevole.
   */
  calendarId: string;
  /**
   * `true` solo quando l'esito DIMOSTRA che l'evento vive su `calendarId`.
   *
   * Un 404/410 non lo dimostra: dice "non l'ho trovato qui", il che e'
   * esattamente cio' che si osserva anche quando si e' bussato al calendario
   * sbagliato. Una assenza non puo' rafforzare la provenienza, altrimenti il
   * primo errore di bersaglio si cristallizzerebbe come verita'.
   */
  calendarIdVerified: boolean;
};

/**
 * Porta l'evento remoto a coincidere con lo stato desiderato.
 *
 * Appuntamento confermato:
 *   GET id
 *     trovato   -> allineato? niente. divergente? PATCH verso Postgres.
 *     404       -> INSERT con l'id memorizzato.
 *                  409 (qualcun altro ha vinto la corsa) -> GET e converge.
 *
 * Appuntamento annullato:
 *   DELETE id, con 404/410 gia' trattati come successo dal provider.
 *
 * Ogni ramo termina in uno stato osservato, mai in un'assunzione.
 */
export async function convergeCalendarEvent(input: {
  provider: CalendarConvergenceProvider;
  integration: GoogleCalendarIntegration;
  target: CalendarConvergenceTarget;
  /**
   * Budget di rete dell'INTERA convergenza.
   *
   * Una convergenza puo' essere refresh + GET + POST + 409 + GET + PATCH: sono
   * un solo gesto applicativo e devono avere un solo tetto. Se non viene
   * passato se ne apre uno qui, cosi' che nessun percorso resti senza.
   */
  budget?: CalendarWriteBudget;
}): Promise<CalendarConvergenceResult> {
  const { provider, integration, target } = input;
  const budget = input.budget ?? createCalendarWriteBudget();
  // La provenienza memorizzata e' un bersaglio, non un suggerimento: quando
  // c'e', ogni chiamata su un evento GIA' ESISTENTE va li'.
  const targeting = calendarTargeting(target);

  if (target.status === 'cancelled') {
    const outcome = await provider.cancelEvent({
      integration,
      eventId: target.eventId,
      ...targeting,
      budget,
    });

    // I due esiti restano distinti fin qui. `already_absent` non e' una
    // cancellazione: e' l'assenza su UN calendario, e non promuove quel
    // calendario a provenienza.
    return {
      eventId: target.eventId,
      htmlLink: null,
      action: outcome.outcome === 'deleted' ? 'deleted' : 'already_absent',
      calendarId: outcome.calendarId,
      calendarIdVerified: outcome.outcome === 'deleted',
    };
  }

  const existing = await provider.getEvent({
    integration,
    eventId: target.eventId,
    ...targeting,
    budget,
  });

  if (existing) {
    return convergeExistingEvent({ provider, integration, target, existing, budget });
  }

  try {
    // La CREAZIONE e' l'unico caso che non ha provenienza da rispettare:
    // l'evento non esiste ancora, quindi nasce sul calendario configurato
    // adesso. Non si passa `targeting`: un bersaglio storico qui sarebbe la
    // scelta sbagliata, e il calendario effettivo torna comunque nel risultato.
    const created = await provider.createEvent({
      integration,
      eventId: target.eventId,
      budget,
      ...eventPayload(target),
    });

    return {
      eventId: created.eventId,
      htmlLink: created.htmlLink,
      action: 'inserted',
      calendarId: created.calendarId,
      calendarIdVerified: true,
    };
  } catch (error) {
    if (googleStatusOf(error) !== 409) {
      throw error;
    }

    // 409 dopo un 404: fra la lettura e la scrittura qualcun altro ha creato
    // l'evento con lo stesso id. Non e' un duplicato — e' esattamente cio'
    // che l'id deterministico serve a garantire — quindi si rilegge e si
    // converge sull'evento che ora esiste.
    const raced = await provider.getEvent({
      integration,
      eventId: target.eventId,
      ...targeting,
      budget,
    });

    if (!raced) {
      throw new AppError(
        'upstream_error',
        'Google Calendar reported a duplicate event id but the event is not readable',
        { cause: error, expose: false },
      );
    }

    return convergeExistingEvent({ provider, integration, target, existing: raced, budget });
  }
}

/**
 * Bersaglio esplicito da passare alle operazioni su un evento esistente.
 *
 * Spread condizionale e non `calendarId: target.calendarId ?? undefined`:
 * con `exactOptionalPropertyTypes` una proprieta' opzionale valorizzata
 * `undefined` non e' la stessa cosa di una proprieta' assente.
 */
function calendarTargeting(target: CalendarConvergenceTarget): { calendarId?: string } {
  const stored = target.calendarId?.trim();

  return stored ? { calendarId: stored } : {};
}

async function convergeExistingEvent(input: {
  provider: CalendarConvergenceProvider;
  integration: GoogleCalendarIntegration;
  target: CalendarConvergenceTarget;
  existing: GoogleCalendarEventSnapshot;
  budget: CalendarWriteBudget;
}): Promise<CalendarConvergenceResult> {
  const { provider, integration, target, existing, budget } = input;

  if (!isDivergent(existing, target)) {
    // L'evento e' stato OSSERVATO su questo calendario: e' una prova positiva,
    // e promuove il bersaglio a provenienza verificata.
    return {
      eventId: existing.eventId,
      htmlLink: existing.htmlLink,
      action: 'unchanged',
      calendarId: existing.calendarId,
      calendarIdVerified: true,
    };
  }

  // `status: 'confirmed'` e' esplicito perche' il caso reale non e' solo
  // l'orario cambiato: un operatore puo' aver cancellato a mano l'evento
  // creato dall'assistente. Google lo restituisce ancora, con status
  // `cancelled`; una PATCH che si limitasse agli orari "riuscirebbe" su un
  // evento invisibile e noi lo marcheremmo sincronizzato.
  const updated = await provider.updateEvent({
    integration,
    eventId: target.eventId,
    // La PATCH raggiunge il calendario su cui l'evento e' appena stato letto,
    // non quello che la configurazione nomina adesso.
    calendarId: existing.calendarId,
    budget,
    status: 'confirmed',
    ...eventPayload(target),
  });

  return {
    eventId: updated.eventId,
    htmlLink: updated.htmlLink,
    action: 'patched',
    calendarId: updated.calendarId,
    calendarIdVerified: true,
  };
}

/**
 * Divergenza fra evento remoto e stato desiderato.
 *
 * Confronta status, inizio e fine. Titolo e descrizione sono volutamente
 * fuori: sono gli unici campi che un operatore ha motivo di ritoccare a mano
 * sul proprio calendario, e riscriverli a ogni tick trasformerebbe la
 * convergenza in una guerra di modifiche contro il suo utente.
 */
function isDivergent(
  existing: GoogleCalendarEventSnapshot,
  target: CalendarConvergenceTarget,
): boolean {
  if (existing.status !== null && existing.status !== 'confirmed') {
    return true;
  }

  if (existing.start === null || existing.end === null) {
    return true;
  }

  return (
    existing.start.getTime() !== target.start.getTime() ||
    existing.end.getTime() !== target.end.getTime()
  );
}

function eventPayload(target: CalendarConvergenceTarget): {
  appointmentId: string;
  tenantId: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  timezone: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
} {
  return {
    appointmentId: target.appointmentId,
    tenantId: target.tenantId,
    summary: target.summary,
    ...(target.description !== undefined ? { description: target.description } : {}),
    ...(target.location !== undefined ? { location: target.location } : {}),
    start: target.start,
    end: target.end,
    timezone: target.timezone,
    customerName: target.customerName,
    ...(target.customerPhone !== undefined ? { customerPhone: target.customerPhone } : {}),
    ...(target.customerEmail !== undefined ? { customerEmail: target.customerEmail } : {}),
  };
}
