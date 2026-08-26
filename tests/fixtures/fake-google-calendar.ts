import { AppError } from '@/lib/errors/app-error';
import type { CalendarConvergenceProvider } from '@/server/appointments/calendar-convergence';
import type {
  CalendarBusyInterval,
  GoogleCalendarDeleteOutcome,
  GoogleCalendarEventResult,
  GoogleCalendarEventSnapshot,
} from '@/server/calendar/google';

/**
 * Google Calendar in memoria.
 *
 * Non e' uno stub che registra chiamate: tiene davvero uno stato, applica il
 * vincolo di unicita' degli id e restituisce 409 su un insert duplicato. E'
 * cio' che rende verificabile l'unica proprieta' che conta davvero, ovvero
 * che nessuna sequenza di guasti produca due eventi per lo stesso
 * appuntamento: il conteggio degli insert riusciti e' osservabile.
 */
export type FakeGoogleEvent = {
  id: string;
  /**
   * Calendario su cui l'evento vive DAVVERO.
   *
   * Non e' un dettaglio del fake: e' la dimensione che rende osservabile il
   * difetto C6. Un evento cercato sul calendario sbagliato non si trova, ed e'
   * esattamente cio' che Google risponde con un 404 — indistinguibile, per chi
   * non guarda il bersaglio, da un evento che non esiste.
   */
  calendarId: string;
  status: 'confirmed' | 'cancelled';
  start: Date;
  end: Date;
  summary: string;
  htmlLink: string;
};

export class FakeGoogleCalendar implements CalendarConvergenceProvider {
  readonly events = new Map<string, FakeGoogleEvent>();

  /** Insert andati a buon fine: la misura diretta dei duplicati. */
  insertCount = 0;
  patchCount = 0;
  deleteCount = 0;
  getCount = 0;

  getError: Error | null = null;
  createError: Error | null = null;
  updateError: Error | null = null;
  cancelError: Error | null = null;

  /**
   * Simula la risposta persa: l'evento viene scritto e poi si solleva.
   * Dal punto di vista del chiamante e' indistinguibile da un timeout.
   */
  createThenFail: Error | null = null;

  /**
   * Traccia condivisa con il repository fake: consente di asserire l'ORDINE
   * fra scrittura su Postgres e chiamata a Google, che per l'annullamento e'
   * la proprieta' in discussione.
   */
  trace: string[] | null = null;

  /**
   * Guasto della VERIFICA di disponibilita'.
   *
   * Separato dagli errori di scrittura di proposito: le proprieta' in
   * discussione in PILOT-P0-2 riguardano la lettura, e confonderle con
   * `createError` renderebbe i test ciechi proprio sulla distinzione che
   * contano di dimostrare.
   */
  listBusyError: Error | null = null;
  listBusyCount = 0;

  constructor(
    private readonly busyIntervals: CalendarBusyInterval[] = [],
    readonly defaultCalendarId: string = 'primary',
  ) {}

  /**
   * Bersaglio effettivo di una operazione, con la stessa regola del provider
   * reale: un `calendarId` esplicito vince, altrimenti si usa quello
   * configurato.
   */
  private target(calendarId?: string): string {
    const explicit = calendarId?.trim();

    return explicit ? explicit : this.defaultCalendarId;
  }

  async listBusy(): Promise<CalendarBusyInterval[]> {
    this.listBusyCount += 1;

    if (this.listBusyError) {
      throw this.listBusyError;
    }

    return this.busyIntervals;
  }

  async getEvent(input: {
    eventId: string;
    calendarId?: string;
  }): Promise<GoogleCalendarEventSnapshot | null> {
    this.getCount += 1;

    if (this.getError) {
      throw this.getError;
    }

    const calendarId = this.target(input.calendarId);
    const event = this.events.get(input.eventId);

    // Assente, oppure vivo su un ALTRO calendario: da qui i due casi si
    // vedono identici, ed e' cosi' anche su Google.
    if (!event || event.calendarId !== calendarId) {
      return null;
    }

    return {
      eventId: event.id,
      htmlLink: event.htmlLink,
      status: event.status,
      start: event.start,
      end: event.end,
      calendarId,
    };
  }

  async createEvent(input: {
    eventId?: string;
    calendarId?: string;
    appointmentId: string;
    summary: string;
    start: Date;
    end: Date;
  }): Promise<GoogleCalendarEventResult> {
    this.trace?.push('google');

    if (this.createError) {
      throw this.createError;
    }

    const calendarId = this.target(input.calendarId);
    const id = input.eventId ?? `generated_${this.events.size + 1}`;

    // L'id e' unico per ACCOUNT, non per calendario: e' quello che rende
    // deterministica la difesa dai duplicati.
    if (this.events.has(id)) {
      throw googleError(409, 'The requested identifier already exists');
    }

    this.events.set(id, {
      id,
      calendarId,
      status: 'confirmed',
      start: input.start,
      end: input.end,
      summary: input.summary,
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
    });
    this.insertCount += 1;

    if (this.createThenFail) {
      throw this.createThenFail;
    }

    return {
      eventId: id,
      htmlLink: `https://calendar.google.com/event?eid=${id}`,
      calendarId,
      raw: {},
    };
  }

  async updateEvent(input: {
    eventId: string;
    calendarId?: string;
    summary: string;
    start: Date;
    end: Date;
    status?: string;
  }): Promise<GoogleCalendarEventResult> {
    this.trace?.push('google');

    if (this.updateError) {
      throw this.updateError;
    }

    const calendarId = this.target(input.calendarId);
    const existing = this.events.get(input.eventId);

    if (!existing || existing.calendarId !== calendarId) {
      throw googleError(404, 'Not Found');
    }

    this.events.set(input.eventId, {
      ...existing,
      start: input.start,
      end: input.end,
      summary: input.summary,
      status: input.status === 'confirmed' ? 'confirmed' : existing.status,
    });
    this.patchCount += 1;

    return {
      eventId: input.eventId,
      htmlLink: existing.htmlLink,
      calendarId,
      raw: {},
    };
  }

  async cancelEvent(input: {
    eventId: string;
    calendarId?: string;
  }): Promise<GoogleCalendarDeleteOutcome> {
    this.trace?.push('google');

    if (this.cancelError) {
      throw this.cancelError;
    }

    const calendarId = this.target(input.calendarId);
    const existing = this.events.get(input.eventId);

    // Non c'era SU QUESTO CALENDARIO. Se vive altrove, e' ancora vivo — e
    // l'esito lo dice invece di dichiarare una cancellazione mai avvenuta.
    if (!existing || existing.calendarId !== calendarId) {
      return { outcome: 'already_absent', calendarId, httpStatus: 404 };
    }

    this.events.delete(input.eventId);
    this.deleteCount += 1;

    return { outcome: 'deleted', calendarId, httpStatus: 204 };
  }

  /** Eventi visibili sul calendario, cioe' non cancellati. */
  activeEvents(): FakeGoogleEvent[] {
    return [...this.events.values()].filter((event) => event.status === 'confirmed');
  }
}

export function googleError(status: number, message: string): AppError {
  return new AppError('upstream_error', message, {
    cause: { status, body: {} },
    expose: false,
  });
}
