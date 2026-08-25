import { AppError } from '@/lib/errors/app-error';

/**
 * Errore tipizzato: "la disponibilita' NON e' stata verificata".
 *
 * Esiste per una ragione sola, ed e' la ragione per cui PILOT-P0-2 esiste:
 * l'assenza di prova non e' prova di assenza. Quando un tenant ha un Google
 * Calendar collegato, la disponibilita' esiste solo se Google l'ha
 * confermata. Un guasto di Google, del token, o della rete non produce
 * "nessuno slot": produce "non lo so", ed e' uno stato diverso che deve
 * restare distinguibile fino all'ultimo strato.
 *
 * Il codice resta `upstream_error` perche' il resto della piattaforma
 * (jsonHandler, outbox, mapping HTTP) sa gia' trattarlo: qui si aggiunge
 * solo l'identita' strutturale che permette al bridge di riconoscerlo con
 * `instanceof` invece di indovinare dal messaggio.
 *
 * NON e' un contenitore generico per le eccezioni. Un `TypeError` nato da un
 * difetto di programmazione del provider deve restare rumoroso: convertirlo
 * qui lo trasformerebbe in un "riprova piu' tardi" e lo renderebbe invisibile.
 */
export type CalendarAvailabilityFailureKind =
  /** 429 / 5xx / timeout / rete: Google c'e', ma non ora. */
  | 'transient'
  /** Credenziali dell'integrazione rotte in modo permanente. */
  | 'auth'
  /** HTTP 200 che non rispetta lo schema, o dati busy non interpretabili. */
  | 'invalid_response'
  /** Configurazione applicativa/server mancante (non e' colpa del tenant). */
  | 'configuration'
  /** Google ha risposto, ma ha rifiutato il calendario richiesto. */
  | 'provider_rejected';

export type CalendarAvailabilityUnavailableOptions = {
  kind: CalendarAvailabilityFailureKind;
  /** Status HTTP di Google, quando la richiesta e' arrivata a destinazione. */
  httpStatus?: number | null;
  /** Ragione applicativa stabile, usata come `availability_error_code`. */
  reason?: string | null;
  cause?: unknown;
};

/**
 * Codice di health persistito su `integrations.availability_error_code`.
 *
 * Solo i guasti realmente specifici dell'integrazione lo scrivono: un 429 o
 * un timeout non significa che il tenant debba ricollegare Google.
 */
export const AVAILABILITY_AUTH_ERROR_CODE = 'google_availability_auth';

export class CalendarAvailabilityUnavailable extends AppError {
  readonly kind: CalendarAvailabilityFailureKind;
  readonly httpStatus: number | null;
  readonly reason: string | null;

  constructor(message: string, options: CalendarAvailabilityUnavailableOptions) {
    super('upstream_error', message, {
      cause: options.cause,
      expose: false,
    });
    this.name = 'CalendarAvailabilityUnavailable';
    this.kind = options.kind;
    this.httpStatus = options.httpStatus ?? null;
    this.reason = options.reason ?? null;
  }

  /**
   * Vero solo quando il guasto dice qualcosa sull'integrazione DI QUESTO
   * tenant, non sulla salute momentanea di Google.
   *
   * E' il predicato che decide se scrivere l'health marker permanente, quindi
   * se il watchdog sveglera' un operatore. Un 403 generico non basta: Google
   * lo usa anche per quota e rate limiting per progetto.
   */
  get isPermanentIntegrationAuthFailure(): boolean {
    return this.kind === 'auth';
  }
}

export function isCalendarAvailabilityUnavailable(
  error: unknown,
): error is CalendarAvailabilityUnavailable {
  return error instanceof CalendarAvailabilityUnavailable;
}
