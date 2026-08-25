import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
import {
  parseGoogleCalendarEventResponse,
  parseGoogleTokenResponse,
  parseGoogleFreeBusyResponseStrict,
  type GoogleCalendarEventResponse,
  type GoogleOAuthTokenResponse,
} from '@/lib/external-schemas/google';
import {
  CalendarAvailabilityUnavailable,
  type CalendarAvailabilityFailureKind,
} from '@/server/calendar/availability-error';
import { readCredentialSecret } from '@/server/integrations/credential-encryption';

export type CalendarBusyInterval = {
  start: Date;
  end: Date;
  source: 'google_calendar' | 'local_appointment';
};

export type GoogleCalendarIntegration = {
  id: string;
  tenantId: string;
  externalAccountId: string | null;
  credentials: Record<string, unknown>;
  config: Record<string, unknown>;
};

export type GoogleCalendarEventInput = {
  appointmentId: string;
  tenantId: string;
  /**
   * Identita' operativa dell'evento su Google.
   *
   * Su `createEvent` viene inviata come `id` nel body: Google accetta id
   * forniti dal chiamante e rifiuta con 409 un id gia' esistente, quindi un
   * insert ripetuto non puo' produrre un secondo evento logico.
   */
  eventId?: string;
  calendarId?: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  timezone: string;
  customerName: string;
  customerPhone?: string | null;
  customerEmail?: string | null;
  /**
   * Stato Google da imporre sull'evento.
   *
   * Usato dalla convergenza per riportare a `confirmed` un evento che un
   * operatore aveva eliminato a mano: senza, una PATCH di soli orari
   * "riuscirebbe" su una tombstone e la riga risulterebbe sincronizzata.
   */
  status?: string;
};

export type GoogleCalendarEventResult = {
  eventId: string;
  htmlLink: string | null;
  raw: unknown;
};

/**
 * Stato osservato di un evento remoto.
 *
 * `status` e' quello di Google (`confirmed` | `tentative` | `cancelled`):
 * un evento eliminato resta leggibile per id con status `cancelled`, e la
 * convergenza deve trattarlo come divergente, non come allineato.
 */
export type GoogleCalendarEventSnapshot = {
  eventId: string;
  htmlLink: string | null;
  status: string | null;
  start: Date | null;
  end: Date | null;
};

type Fetcher = typeof fetch;

type GoogleCalendarProviderOptions = {
  fetcher?: Fetcher;
  apiBaseUrl?: string;
  tokenUrl?: string;
  oauthClientId?: string;
  oauthClientSecret?: string;
  onTokenRefresh?: (input: {
    integration: GoogleCalendarIntegration;
    accessToken: string;
    expiresAt: number | null;
    scope: string | null;
    tokenType: string | null;
  }) => Promise<void>;
};

// I tipi `GoogleOAuthTokenResponse`, `GoogleFreeBusyResponse`,
// `GoogleCalendarEventResponse` sono definiti in
// `@/lib/external-schemas/google` e validati con Zod a runtime.

export class GoogleCalendarProvider {
  private readonly fetcher: Fetcher;
  private readonly apiBaseUrl: string;
  private readonly tokenUrl: string;
  private readonly oauthClientId: string;
  private readonly oauthClientSecret: string;
  private readonly onTokenRefresh: GoogleCalendarProviderOptions['onTokenRefresh'];

  constructor(options: GoogleCalendarProviderOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiBaseUrl = options.apiBaseUrl ?? 'https://www.googleapis.com/calendar/v3';
    this.tokenUrl = options.tokenUrl ?? env.GOOGLE_OAUTH_TOKEN_URL;
    this.oauthClientId = options.oauthClientId ?? env.GOOGLE_OAUTH_CLIENT_ID;
    this.oauthClientSecret = options.oauthClientSecret ?? env.GOOGLE_OAUTH_CLIENT_SECRET;
    this.onTokenRefresh = options.onTokenRefresh;
  }

  /**
   * Confine di normalizzazione della DISPONIBILITA'.
   *
   * Tutto cio' che qui dentro puo' fallire in modo previsto — token, rete,
   * HTTP, schema, calendario rifiutato, intervalli illeggibili — esce come
   * `CalendarAvailabilityUnavailable`, cioe' "non lo so", mai come lista
   * vuota. La lista vuota resta riservata all'unico caso in cui Google ha
   * davvero risposto "questo calendario non ha impegni".
   *
   * La normalizzazione e' deliberatamente per-operazione e non un `catch`
   * attorno al metodo: un `TypeError` nato da un difetto di questo file deve
   * continuare a propagarsi tale e quale. Un bug di programmazione mascherato
   * da "riprova piu' tardi" e' un bug che nessuno vedra' mai.
   *
   * Le scritture (`createEvent`/`updateEvent`/`cancelEvent`) NON passano di
   * qui e mantengono la semantica di PILOT-P0-1 invariata.
   */
  async listBusy(input: {
    integration: GoogleCalendarIntegration;
    from: Date;
    to: Date;
    timezone: string;
  }): Promise<CalendarBusyInterval[]> {
    const calendarId = calendarIdForIntegration(input.integration);
    const accessToken = await this.acquireAvailabilityAccessToken(input.integration);
    const response = await this.requestFreeBusy({
      accessToken,
      calendarId,
      from: input.from,
      to: input.to,
      timezone: input.timezone,
    });
    const rawBody = await readAvailabilityBody(response);

    // L'esito HTTP si classifica PRIMA di pretendere lo schema di successo:
    // un 429 non e' una risposta malformata, e chiamarla tale perderebbe
    // l'unica informazione che dice all'operatore cosa sta succedendo.
    if (!response.ok) {
      throw availabilityErrorFromFreeBusyStatus(response.status, rawBody);
    }

    const parsed = parseGoogleFreeBusyResponseStrict(rawBody);

    if (!parsed.success) {
      throw new CalendarAvailabilityUnavailable(
        'Google Calendar freeBusy returned an unreadable response',
        {
          kind: 'invalid_response',
          httpStatus: response.status,
          reason: 'freebusy_schema_invalid',
          cause: { issue: parsed.issue },
        },
      );
    }

    const calendar = parsed.data.calendars[calendarId];

    // Chiave assente: Google non ha detto "libero", non ha detto niente del
    // calendario che abbiamo chiesto.
    if (!calendar) {
      throw new CalendarAvailabilityUnavailable(
        'Google Calendar freeBusy omitted the requested calendar',
        {
          kind: 'invalid_response',
          httpStatus: response.status,
          reason: 'freebusy_calendar_missing',
        },
      );
    }

    const firstError = calendar.errors?.[0];

    if (firstError) {
      throw new CalendarAvailabilityUnavailable(
        `Google Calendar freeBusy rejected the calendar (${firstError.reason ?? 'error'})`,
        {
          kind: 'provider_rejected',
          httpStatus: response.status,
          reason: `freebusy_calendar_error:${firstError.reason ?? 'unknown'}`,
        },
      );
    }

    return (calendar.busy ?? []).map((interval) =>
      toAvailabilityBusyInterval(interval, response.status),
    );
  }

  /**
   * Acquisizione del token DENTRO il perimetro disponibilita'.
   *
   * `getAccessToken` resta condiviso con le scritture: qui si aggiungono solo
   * il budget di rete e la traduzione dell'esito, e solo per questa chiamata.
   */
  private async acquireAvailabilityAccessToken(
    integration: GoogleCalendarIntegration,
  ): Promise<string> {
    try {
      return await this.getAccessToken(integration, { network: AVAILABILITY_NETWORK });
    } catch (error) {
      // Solo gli AppError sono guasti PREVISTI delle dipendenze note
      // (credenziali, refresh HTTP, persistenza del token). Qualunque altra
      // eccezione e' un difetto e resta tale.
      if (error instanceof AppError) {
        throw availabilityErrorFromTokenFailure(error);
      }

      throw error;
    }
  }

  private async requestFreeBusy(input: {
    accessToken: string;
    calendarId: string;
    from: Date;
    to: Date;
    timezone: string;
  }): Promise<Response> {
    try {
      // `fetchWithTimeout` converte timeout e guasti di rete in AppError:
      // qui resta solo da dargli l'identita' di errore di disponibilita'.
      return await fetchWithTimeout(
        `${this.apiBaseUrl}/freeBusy`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${input.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            timeMin: input.from.toISOString(),
            timeMax: input.to.toISOString(),
            timeZone: input.timezone,
            items: [{ id: input.calendarId }],
          }),
        },
        {
          timeoutMs: AVAILABILITY_NETWORK.timeoutMs,
          retries: 0,
          fetchImpl: this.fetcher,
          label: 'Google Calendar freeBusy',
        },
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw new CalendarAvailabilityUnavailable('Google Calendar freeBusy could not be reached', {
          kind: 'transient',
          reason: 'freebusy_transport_failure',
          cause: error,
        });
      }

      throw error;
    }
  }

  /**
   * Legge un evento per id.
   *
   * Ritorna `null` quando Google risponde 404/410: per la convergenza
   * "non esiste" e' un esito normale, non un errore. Leggere prima di
   * scrivere e' cio' che rende sicura la ripetizione di un insert il cui
   * esito era stato perso: la creazione parte solo se l'evento davvero
   * non c'e'.
   */
  async getEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
  }): Promise<GoogleCalendarEventSnapshot | null> {
    const calendarId = input.calendarId ?? calendarIdForIntegration(input.integration);
    const accessToken = await this.getAccessToken(input.integration);
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );

    const response = await this.fetcher(url.toString(), {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 404 || response.status === 410) {
      return null;
    }

    const rawBody = await readJson(response);

    if (!response.ok) {
      throw googleCalendarError('Google Calendar event read failed', response, rawBody);
    }

    const body: GoogleCalendarEventResponse = parseGoogleCalendarEventResponse(rawBody);

    return {
      eventId: body.id ?? input.eventId,
      htmlLink: body.htmlLink ?? null,
      status: body.status ?? null,
      start: optionalGoogleDate(body.start?.dateTime),
      end: optionalGoogleDate(body.end?.dateTime),
    };
  }

  async createEvent(
    input: GoogleCalendarEventInput & {
      integration: GoogleCalendarIntegration;
    },
  ): Promise<GoogleCalendarEventResult> {
    const calendarId = input.calendarId ?? calendarIdForIntegration(input.integration);
    const accessToken = await this.getAccessToken(input.integration);
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(`${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.fetcher(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...(input.eventId ? { id: input.eventId } : {}),
        ...googleCalendarEventBody(input),
      }),
    });
    const rawBody = await readJson(response);
    const body: GoogleCalendarEventResponse = parseGoogleCalendarEventResponse(rawBody);

    if (!response.ok) {
      throw googleCalendarError('Google Calendar event insert failed', response, rawBody);
    }

    if (!body.id) {
      throw new AppError('upstream_error', 'Google Calendar event insert returned no event id', {
        cause: rawBody,
        expose: false,
      });
    }

    return {
      eventId: body.id,
      htmlLink: body.htmlLink ?? null,
      raw: rawBody,
    };
  }

  async updateEvent(
    input: GoogleCalendarEventInput & {
      integration: GoogleCalendarIntegration;
      eventId: string;
    },
  ): Promise<GoogleCalendarEventResult> {
    const calendarId = input.calendarId ?? calendarIdForIntegration(input.integration);
    const accessToken = await this.getAccessToken(input.integration);
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.fetcher(url.toString(), {
      method: 'PATCH',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(googleCalendarEventBody(input)),
    });
    const rawBody = await readJson(response);
    const body: GoogleCalendarEventResponse = parseGoogleCalendarEventResponse(rawBody);

    if (!response.ok) {
      throw googleCalendarError('Google Calendar event update failed', response, rawBody);
    }

    if (!body.id) {
      throw new AppError('upstream_error', 'Google Calendar event update returned no event id', {
        cause: rawBody,
        expose: false,
      });
    }

    return {
      eventId: body.id,
      htmlLink: body.htmlLink ?? null,
      raw: rawBody,
    };
  }

  async cancelEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
  }): Promise<{ cancelled: true }> {
    const calendarId = input.calendarId ?? calendarIdForIntegration(input.integration);
    const accessToken = await this.getAccessToken(input.integration);
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.fetcher(url.toString(), {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    if ([200, 204, 404, 410].includes(response.status)) {
      return { cancelled: true };
    }

    const body = await readJson(response);

    throw googleCalendarError('Google Calendar event delete failed', response, body);
  }

  /**
   * Condiviso fra disponibilita' e scritture.
   *
   * `options.network` e' passato SOLO dal percorso disponibilita': senza,
   * la chiamata di refresh resta identica a PILOT-P0-1 (nessun timeout
   * aggiuntivo, nessuna riclassificazione). Il budget di rete della
   * disponibilita' non deve poter accorciare una scrittura di calendario.
   */
  private async getAccessToken(
    integration: GoogleCalendarIntegration,
    options: { network?: AvailabilityNetworkPolicy } = {},
  ): Promise<string> {
    const accessToken = readCredentialSecret(integration.credentials, 'access_token');
    const expiresAt = numberFromRecord(integration.credentials, 'expires_at');
    const expiresAtMs = expiresAt ? expiresAt * (expiresAt > 10_000_000_000 ? 1 : 1000) : null;

    if (accessToken && (!expiresAtMs || expiresAtMs > Date.now() + 60_000)) {
      return accessToken;
    }

    const refreshToken = readCredentialSecret(integration.credentials, 'refresh_token');

    if (!refreshToken) {
      throw new AppError(
        'upstream_error',
        'Google Calendar credentials are missing access_token or refresh_token',
        { expose: false, cause: { [GOOGLE_AUTH_FAILURE]: 'missing_credentials' } },
      );
    }

    if (!this.oauthClientId || !this.oauthClientSecret) {
      throw new AppError('internal', 'Google OAuth client credentials are not configured', {
        expose: false,
      });
    }

    const tokenRequest: RequestInit = {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.oauthClientId,
        client_secret: this.oauthClientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    };
    const response = options.network
      ? await fetchWithTimeout(this.tokenUrl, tokenRequest, {
          timeoutMs: options.network.timeoutMs,
          retries: 0,
          fetchImpl: this.fetcher,
          label: 'Google OAuth token refresh',
        })
      : await this.fetcher(this.tokenUrl, tokenRequest);
    const rawBody = options.network
      ? await readAvailabilityBody(response)
      : await readJson(response);
    const body: GoogleOAuthTokenResponse = parseGoogleTokenResponse(rawBody);

    if (!response.ok || !body.access_token) {
      throw googleCalendarError('Google OAuth token refresh failed', response, rawBody);
    }

    await this.onTokenRefresh?.({
      integration,
      accessToken: body.access_token,
      expiresAt: body.expires_in ? Math.floor((Date.now() + body.expires_in * 1000) / 1000) : null,
      scope: null,
      tokenType: body.token_type ?? null,
    });

    return body.access_token;
  }
}

/**
 * Budget di rete della DISPONIBILITA'.
 *
 * 3 secondi e zero retry automatici. Il turno WhatsApp ha un tetto imposto da
 * Meta e il cliente sta aspettando: una risposta deterministica "riprova fra
 * poco" arrivata in tempo vale piu' di una risposta perfetta arrivata dopo che
 * il webhook e' scaduto. Il ritentativo e' un gesto esplicito del cliente, non
 * un ciclo nascosto dentro il turno.
 *
 * Vale SOLO per le chiamate fatte da `listBusy`. Le scritture di calendario di
 * PILOT-P0-1 conservano il timeout di default.
 */
type AvailabilityNetworkPolicy = { timeoutMs: number };

const AVAILABILITY_NETWORK: AvailabilityNetworkPolicy = { timeoutMs: 3_000 };

/**
 * Marcatore sulla `cause` dei guasti di credenziali.
 *
 * Serve a classificare senza leggere il messaggio dell'errore: un match sul
 * testo si rompe alla prima riformulazione, e qui il testo decide se un
 * operatore verra' svegliato.
 */
const GOOGLE_AUTH_FAILURE = 'googleAuthFailure';

/**
 * Traduce un guasto HTTP di freeBusy in un esito di disponibilita'.
 *
 * 401 e' l'unico status che da solo dimostra credenziali rotte. Il 403 di
 * Google copre anche quota superata e rate limit di progetto: trattarlo come
 * rottura permanente marcherebbe come "da ricollegare" integrazioni
 * perfettamente sane.
 */
function availabilityErrorFromFreeBusyStatus(
  status: number,
  rawBody: unknown,
): CalendarAvailabilityUnavailable {
  const kind: CalendarAvailabilityFailureKind =
    status === 401
      ? 'auth'
      : status === 403 || status === 429 || status >= 500
        ? 'transient'
        : 'provider_rejected';

  return new CalendarAvailabilityUnavailable(`Google Calendar freeBusy failed (${status})`, {
    kind,
    httpStatus: status,
    reason: `freebusy_http_${status}`,
    cause: { status, googleError: googleErrorCode(rawBody) },
  });
}

/**
 * Traduce un guasto di acquisizione token in un esito di disponibilita'.
 *
 * `invalid_grant` viene letto dal body GREZZO e non dal parse lenient: quel
 * parser, davanti a una risposta che non riconosce, ritorna `{}` — e `{}` non
 * contiene `invalid_grant`, quindi una revoca del consenso passerebbe per un
 * guasto passeggero e nessuno chiederebbe mai al tenant di ricollegare Google.
 */
function availabilityErrorFromTokenFailure(error: AppError): CalendarAvailabilityUnavailable {
  const cause = plainRecord(error.cause);

  if (cause?.[GOOGLE_AUTH_FAILURE] === 'missing_credentials') {
    return new CalendarAvailabilityUnavailable(
      'Google Calendar availability has no usable stored credentials',
      { kind: 'auth', reason: 'missing_credentials', cause: error },
    );
  }

  // Configurazione applicativa mancante: il turno degrada in modo
  // deterministico, ma l'integrazione del tenant non e' rotta e non deve
  // finire sotto il watchdog come "da ricollegare".
  if (error.code === 'internal') {
    return new CalendarAvailabilityUnavailable(
      'Google Calendar availability is not configured on this deployment',
      { kind: 'configuration', reason: 'oauth_client_not_configured', cause: error },
    );
  }

  const status = typeof cause?.status === 'number' ? cause.status : null;
  const googleError = googleErrorCode(cause?.body);

  if (googleError === 'invalid_grant' || status === 401) {
    return new CalendarAvailabilityUnavailable('Google Calendar refresh token is no longer valid', {
      kind: 'auth',
      httpStatus: status,
      reason: googleError === 'invalid_grant' ? 'invalid_grant' : 'token_refresh_unauthorized',
      cause: { status },
    });
  }

  if (status !== null && status !== 403 && status !== 429 && status < 500) {
    return new CalendarAvailabilityUnavailable(
      `Google Calendar token refresh was rejected (${status})`,
      { kind: 'provider_rejected', httpStatus: status, reason: `token_refresh_http_${status}` },
    );
  }

  // Resto: trasporto, 403/429/5xx, e i guasti del repository incontrati
  // mentre si persisteva il token rinfrescato. Nessuno di questi dimostra
  // che l'integrazione sia rotta.
  return new CalendarAvailabilityUnavailable(
    'Google Calendar availability could not acquire an access token',
    {
      kind: 'transient',
      httpStatus: status,
      reason: status === null ? 'token_acquisition_failed' : `token_refresh_http_${status}`,
      cause: error,
    },
  );
}

/**
 * Un intervallo busy che non sappiamo leggere non e' un intervallo da
 * scartare: scartarlo significa dichiarare libero un tempo che Google aveva
 * dichiarato occupato.
 */
function toAvailabilityBusyInterval(
  interval: { start: string; end: string },
  httpStatus: number,
): CalendarBusyInterval {
  const start = new Date(interval.start);
  const end = new Date(interval.end);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) {
    throw new CalendarAvailabilityUnavailable(
      'Google Calendar freeBusy returned an unreadable busy interval',
      {
        kind: 'invalid_response',
        httpStatus,
        reason: 'freebusy_interval_invalid',
      },
    );
  }

  return { start, end, source: 'google_calendar' };
}

/**
 * Lettura del corpo della risposta sul percorso disponibilita'.
 *
 * `response.text()` puo' fallire a stream interrotto: e' un guasto esterno
 * previsto di QUESTA operazione, non un difetto del codice, quindi viene
 * normalizzato qui e non piu' in alto.
 */
async function readAvailabilityBody(response: Response): Promise<unknown> {
  try {
    return await readJson(response);
  } catch (error) {
    throw new CalendarAvailabilityUnavailable('Google Calendar response body could not be read', {
      kind: 'transient',
      httpStatus: response.status,
      reason: 'response_body_unreadable',
      cause: error,
    });
  }
}

/** Legge `error` (OAuth) o `error.status`/`error.errors[].reason` (Calendar). */
function googleErrorCode(body: unknown): string | null {
  const record = plainRecord(body);

  if (!record) {
    return null;
  }

  if (typeof record.error === 'string' && record.error.trim()) {
    return record.error.trim();
  }

  const nested = plainRecord(record.error);
  const reason = Array.isArray(nested?.errors) ? plainRecord(nested.errors[0])?.reason : null;

  return typeof reason === 'string' && reason.trim() ? reason.trim() : null;
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function googleCalendarEventBody(input: GoogleCalendarEventInput): Record<string, unknown> {
  return {
    ...(input.status ? { status: input.status } : {}),
    summary: input.summary,
    description: input.description,
    location: input.location,
    start: {
      dateTime: input.start.toISOString(),
      timeZone: input.timezone,
    },
    end: {
      dateTime: input.end.toISOString(),
      timeZone: input.timezone,
    },
    attendees: attendeeList(input.customerEmail),
    transparency: 'opaque',
    reminders: {
      useDefault: false,
    },
    extendedProperties: {
      private: {
        source: 'ambrogio.ai',
        tenantId: input.tenantId,
        appointmentId: input.appointmentId,
        customerPhone: input.customerPhone ?? '',
      },
    },
  };
}

function calendarIdForIntegration(integration: GoogleCalendarIntegration): string {
  return (
    stringFromRecord(integration.config, 'calendar_id') ??
    stringFromRecord(integration.config, 'calendarId') ??
    integration.externalAccountId ??
    'primary'
  );
}

function sendUpdatesForIntegration(
  integration: GoogleCalendarIntegration,
): 'all' | 'externalOnly' | 'none' {
  const value =
    stringFromRecord(integration.config, 'send_updates') ??
    stringFromRecord(integration.config, 'sendUpdates');

  if (value === 'all' || value === 'externalOnly' || value === 'none') {
    return value;
  }

  return 'none';
}

function attendeeList(
  customerEmail?: string | null,
): Array<{ email: string; displayName?: string }> | undefined {
  const email = customerEmail?.trim();

  return email ? [{ email }] : undefined;
}

/**
 * Estremo temporale opzionale: un estremo assente o all-day diventa `null`,
 * che la convergenza legge come divergenza.
 */
function optionalGoogleDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text.trim()) {
    return {};
  }

  try {
    // JSON.parse ritorna `any`; lo trattiamo come `unknown` per forzare
    // narrowing nei chiamanti (Zod parse o type guards).
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return { raw: text };
  }
}

function googleCalendarError(message: string, response: Response, body: unknown): AppError {
  return new AppError('upstream_error', message, {
    cause: {
      status: response.status,
      body,
    },
    expose: false,
  });
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];

  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberFromRecord(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
