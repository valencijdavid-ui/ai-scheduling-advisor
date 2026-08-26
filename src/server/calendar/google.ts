import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { DEFAULT_TIMEOUT_MS, fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
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
  /**
   * Calendario CONTATTATO DAVVERO da questa operazione.
   *
   * Torna al chiamante perche' la provenienza va persistita nello stesso
   * settle che registra l'esito. Ricostruirla dopo, rileggendo la
   * configurazione corrente dell'integrazione, significherebbe dedurre una
   * verita' storica da un valore che nel frattempo puo' essere cambiato.
   */
  calendarId: string;
  raw: unknown;
};

/**
 * Esito di una DELETE, non collassato.
 *
 * `cancelEvent` restituiva `{ cancelled: true }` per 200, 204, 404 e 410
 * indistintamente. Sono tre fatti diversi:
 *
 *   deleted        l'evento c'era su QUESTO calendario e non c'e' piu'
 *   already_absent non c'era su QUESTO calendario — che NON vuol dire che non
 *                  esista altrove
 *
 * La differenza e' portante: un worker di cancellazione che manda la DELETE
 * al calendario sbagliato riceve 404, e se 404 valesse "fatto" chiuderebbe un
 * debito il cui evento — con dentro il telefono del cliente — e' vivo.
 * C-i non decide ancora cosa farne: conserva la prova.
 */
export type GoogleCalendarDeleteOutcome = {
  outcome: 'deleted' | 'already_absent';
  calendarId: string;
  httpStatus: number;
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
  /** Calendario su cui l'evento e' stato effettivamente OSSERVATO. */
  calendarId: string;
};

/**
 * Budget di rete di UNA operazione di convergenza.
 *
 * Un timeout per-fetch non basta e non e' un dettaglio: una convergenza puo'
 * essere refresh del token + GET + POST + 409 + GET + PATCH. Con il solo
 * timeout per chiamata il tetto complessivo e' la somma, cioe' un numero che
 * nessuno ha scelto. La scadenza qui e' assoluta e appartiene all'operazione:
 * e' l'applicazione a decidere quanto e' disposta ad aspettare, non la
 * piattaforma su cui gira.
 */
export type CalendarWriteBudget = {
  /** Istante oltre il quale nessuna nuova chiamata puo' partire. */
  readonly deadlineAt: number;
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
    budget?: CalendarWriteBudget;
  }): Promise<GoogleCalendarEventSnapshot | null> {
    const calendarId = effectiveCalendarId(input.integration, input.calendarId);
    const budget = input.budget ?? createCalendarWriteBudget();
    const accessToken = await this.getAccessToken(input.integration, { budget });
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );

    const response = await this.writeFetch(
      url.toString(),
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      budget,
      'Google Calendar event read',
    );

    if (response.status === 404 || response.status === 410) {
      return null;
    }

    const rawBody = await readBoundedJson(response, budget);

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
      calendarId,
    };
  }

  async createEvent(
    input: GoogleCalendarEventInput & {
      integration: GoogleCalendarIntegration;
      budget?: CalendarWriteBudget;
    },
  ): Promise<GoogleCalendarEventResult> {
    const calendarId = effectiveCalendarId(input.integration, input.calendarId);
    const budget = input.budget ?? createCalendarWriteBudget();
    const accessToken = await this.getAccessToken(input.integration, { budget });
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(`${this.apiBaseUrl}/calendars/${encodeURIComponent(calendarId)}/events`);
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.writeFetch(
      url.toString(),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          ...(input.eventId ? { id: input.eventId } : {}),
          ...googleCalendarEventBody(input),
        }),
      },
      budget,
      'Google Calendar event insert',
    );
    const rawBody = await readBoundedJson(response, budget);
    const body: GoogleCalendarEventResponse = parseGoogleCalendarEventResponse(rawBody);

    if (!response.ok) {
      throw googleCalendarError(
        'Google Calendar event insert failed',
        response,
        rawBody,
        'mutation',
      );
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
      calendarId,
      raw: rawBody,
    };
  }

  async updateEvent(
    input: GoogleCalendarEventInput & {
      integration: GoogleCalendarIntegration;
      eventId: string;
      budget?: CalendarWriteBudget;
    },
  ): Promise<GoogleCalendarEventResult> {
    const calendarId = effectiveCalendarId(input.integration, input.calendarId);
    const budget = input.budget ?? createCalendarWriteBudget();
    const accessToken = await this.getAccessToken(input.integration, { budget });
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.writeFetch(
      url.toString(),
      {
        method: 'PATCH',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(googleCalendarEventBody(input)),
      },
      budget,
      'Google Calendar event update',
    );
    const rawBody = await readBoundedJson(response, budget);
    const body: GoogleCalendarEventResponse = parseGoogleCalendarEventResponse(rawBody);

    if (!response.ok) {
      throw googleCalendarError(
        'Google Calendar event update failed',
        response,
        rawBody,
        'mutation',
      );
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
      calendarId,
      raw: rawBody,
    };
  }

  /**
   * Cancella l'evento e DICE QUALE dei due fatti e' successo.
   *
   * 200/204 -> l'evento c'era su questo calendario e non c'e' piu'.
   * 404/410 -> non c'era SU QUESTO CALENDARIO. Non e' la stessa cosa di "non
   *            esiste": se il tenant ha cambiato calendario, l'evento storico
   *            e' vivo altrove e questa risposta non lo sa.
   *
   * Entrambi restano esiti di successo per un annullamento normale — la
   * proiezione desiderata e' "nessun evento", e in tutti e due i casi qui non
   * c'e' — ma la prova resta distinguibile.
   */
  async cancelEvent(input: {
    integration: GoogleCalendarIntegration;
    eventId: string;
    calendarId?: string;
    budget?: CalendarWriteBudget;
  }): Promise<GoogleCalendarDeleteOutcome> {
    const calendarId = effectiveCalendarId(input.integration, input.calendarId);
    const budget = input.budget ?? createCalendarWriteBudget();
    const accessToken = await this.getAccessToken(input.integration, { budget });
    const sendUpdates = sendUpdatesForIntegration(input.integration);
    const url = new URL(
      `${this.apiBaseUrl}/calendars/${encodeURIComponent(
        calendarId,
      )}/events/${encodeURIComponent(input.eventId)}`,
    );
    url.searchParams.set('sendUpdates', sendUpdates);

    const response = await this.writeFetch(
      url.toString(),
      {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      budget,
      'Google Calendar event delete',
    );

    if (response.status === 200 || response.status === 204) {
      return { outcome: 'deleted', calendarId, httpStatus: response.status };
    }

    if (response.status === 404 || response.status === 410) {
      return { outcome: 'already_absent', calendarId, httpStatus: response.status };
    }

    const body = await readBoundedJson(response, budget);

    throw googleCalendarError('Google Calendar event delete failed', response, body, 'mutation');
  }

  /**
   * Unica porta di rete delle SCRITTURE.
   *
   * `retries: 0` non e' un default ereditato: e' la regola. Un ritentativo
   * automatico su POST/PATCH/DELETE al livello HTTP e' un secondo tentativo
   * fatto senza sapere se il primo e' arrivato, e `fetchWithTimeout` lo
   * rifiuta comunque per i metodi non idempotenti. Il ritentativo di una
   * mutazione appartiene al livello dell'INTENTO DUREVOLE, dove esiste una
   * traccia di cosa era stato chiesto.
   */
  private async writeFetch(
    url: string,
    init: RequestInit,
    budget: CalendarWriteBudget,
    label: string,
  ): Promise<Response> {
    return fetchWithTimeout(url, init, {
      timeoutMs: calendarWriteStepTimeoutMs(budget, label),
      retries: 0,
      fetchImpl: this.fetcher,
      label,
    });
  }

  /**
   * Condiviso fra disponibilita' e scritture.
   *
   * Le due politiche di rete sono disgiunte e non si contaminano:
   * `options.network` e' il tetto di 3s della disponibilita';
   * `options.budget` e' il budget dell'operazione di scrittura. Il refresh del
   * token e' una chiamata di rete come le altre e sta DENTRO il budget di chi
   * lo ha chiesto — altrimenti il tetto dell'operazione sarebbe dichiarato ma
   * non vero.
   */
  private async getAccessToken(
    integration: GoogleCalendarIntegration,
    policy: CalendarTokenPolicy,
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
    const response = await fetchWithTimeout(this.tokenUrl, tokenRequest, {
      timeoutMs:
        'network' in policy
          ? policy.network.timeoutMs
          : calendarWriteStepTimeoutMs(policy.budget, TOKEN_REFRESH_LABEL),
      // Il refresh e' un POST: un ritentativo automatico e' comunque escluso.
      retries: 0,
      fetchImpl: this.fetcher,
      label: TOKEN_REFRESH_LABEL,
    });
    const rawBody =
      'network' in policy
        ? await readAvailabilityBody(response)
        : await readBoundedJson(response, policy.budget);
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

/**
 * Politica di rete di UNA acquisizione di token.
 *
 * E' un'unione, non due campi opzionali, e la differenza e' sostanziale: cosi'
 * NON ESISTE la chiamata senza politica. Finche' i due campi erano opzionali,
 * un refresh non limitato era a un argomento dimenticato di distanza — e un
 * token refresh fuori dal budget renderebbe falso il tetto che l'operazione
 * dichiara di avere.
 */
type CalendarTokenPolicy = { network: AvailabilityNetworkPolicy } | { budget: CalendarWriteBudget };

const AVAILABILITY_NETWORK: AvailabilityNetworkPolicy = { timeoutMs: 3_000 };

/**
 * Marcatore sulla `cause` dei guasti di credenziali.
 *
 * Serve a classificare senza leggere il messaggio dell'errore: un match sul
 * testo si rompe alla prima riformulazione, e qui il testo decide se un
 * operatore verra' svegliato.
 */
const GOOGLE_AUTH_FAILURE = 'googleAuthFailure';

const TOKEN_REFRESH_LABEL = 'Google OAuth token refresh';

/**
 * Marcatore sulla `cause` degli errori nati da una MUTAZIONE gia' trasmessa.
 *
 * Serve a distinguere due guasti che hanno lo stesso aspetto — un AppError con
 * uno status HTTP — ma raccontano fatti opposti:
 *
 *   GET fallito           nessuna mutazione era in gioco: non c'e' niente di
 *                         ignoto da conservare.
 *   POST/PATCH/DELETE     la richiesta e' ARRIVATA a Google. Cosa ne abbia
 *                         fatto lo dice lo status, e solo fino a un certo
 *                         punto: vedi `isUnknownCalendarWriteOutcome`.
 *
 * Il refresh del token NON lo porta, ed e' voluto: e' un POST, ma un suo
 * fallimento avviene PRIMA che qualunque mutazione di evento parta.
 */
const GOOGLE_MUTATION_TRANSMITTED = 'googleMutationTransmitted';

/**
 * Budget di rete delle SCRITTURE.
 *
 * `stepTimeoutMs` resta il default di PILOT-P0-1: una scrittura fatta di una
 * sola chiamata si comporta esattamente come prima. Cio' che si aggiunge e'
 * `operationBudgetMs`, il tetto dell'INTERA operazione — refresh del token,
 * GET, POST, il 409, la GET di rilettura e la PATCH sono un solo gesto
 * applicativo, e senza un tetto comune la loro durata massima e' la somma dei
 * timeout, cioe' un numero che nessuno ha scelto.
 *
 * 12s sta dentro lo stesso involucro di ~20s che Meta concede al webhook e per
 * cui era stato scelto `DEFAULT_TIMEOUT_MS`. Il reconciler, che non vive in un
 * turno, puo' chiedere esplicitamente un budget piu' ampio: e' un parametro,
 * non una costante nascosta.
 */
const CALENDAR_WRITE_NETWORK = {
  operationBudgetMs: 12_000,
  stepTimeoutMs: DEFAULT_TIMEOUT_MS,
  /**
   * Un corpo di risposta e' comunque memoria di questo processo: senza un
   * tetto, una risposta anomala verrebbe bufferizzata per intero.
   */
  maxResponseBytes: 1_048_576,
} as const;

/**
 * Marcatore sulla `cause` dei guasti da scadenza del budget di scrittura.
 *
 * `phase` distingue i due fatti che NON vanno confusi:
 *
 *   not_attempted  il budget era gia' esaurito PRIMA che la chiamata partisse:
 *                  nulla e' stato inviato, e questo e' un fatto certo.
 *   ambiguous      la scadenza e' scattata MENTRE la chiamata era in volo:
 *                  Google puo' averla ricevuta ed eseguita. Esito IGNOTO.
 *
 * Collassare i due significherebbe, nel caso ambiguo, dichiarare "non fatto"
 * una mutazione che potrebbe essere avvenuta.
 */
const CALENDAR_WRITE_DEADLINE = 'calendarWriteDeadline';

export type CalendarWriteDeadlinePhase = 'not_attempted' | 'ambiguous';

/**
 * Apre il budget di UNA operazione di scrittura.
 *
 * Il chiamante lo crea una volta e lo passa a tutte le chiamate del gesto: e'
 * questo che rende il tetto una proprieta' dell'operazione e non della singola
 * richiesta.
 */
export function createCalendarWriteBudget(
  operationBudgetMs: number = CALENDAR_WRITE_NETWORK.operationBudgetMs,
): CalendarWriteBudget {
  return { deadlineAt: Date.now() + operationBudgetMs };
}

export function calendarWriteBudgetRemainingMs(budget: CalendarWriteBudget): number {
  return budget.deadlineAt - Date.now();
}

/**
 * Timeout della singola chiamata, subordinato al budget dell'operazione.
 *
 * Se il budget e' gia' esaurito la chiamata NON parte: e' l'unico modo di
 * garantire che nessuna richiesta nasca oltre la scadenza dichiarata.
 */
function calendarWriteStepTimeoutMs(budget: CalendarWriteBudget, label: string): number {
  const remaining = calendarWriteBudgetRemainingMs(budget);

  if (remaining <= 0) {
    throw calendarWriteDeadlineError(label, 'not_attempted');
  }

  return Math.min(remaining, CALENDAR_WRITE_NETWORK.stepTimeoutMs);
}

function calendarWriteDeadlineError(label: string, phase: CalendarWriteDeadlinePhase): AppError {
  return new AppError(
    'upstream_error',
    phase === 'not_attempted'
      ? `${label} was not attempted: the calendar write budget was already exhausted`
      : `${label} exceeded the calendar write budget while in flight`,
    { expose: false, cause: { [CALENDAR_WRITE_DEADLINE]: phase } },
  );
}

/**
 * Dice se un guasto lascia l'esito remoto IGNOTO.
 *
 * Serve a chi registra l'esito di una mutazione: solo un guasto che dimostra
 * il non-invio puo' essere archiviato come "non fatto".
 *
 * I tre casi, e perche' sono tre e non due:
 *
 *   budget esaurito PRIMA della partenza -> `not_attempted`. Niente e' stato
 *     trasmesso, ed e' un fatto certo: non c'e' nessuna ignoranza da
 *     conservare.
 *
 *   timeout o guasto di trasporto -> IGNOTO. La richiesta puo' essere arrivata
 *     lo stesso: il client ha smesso di aspettare, non ha ricevuto un rifiuto.
 *
 *   risposta HTTP a una MUTAZIONE -> dipende dallo status, e la riga di
 *     confine sta a 500:
 *       4xx  Google ha VALUTATO la richiesta e l'ha respinta. Non ha applicato
 *            niente, e quel fatto e' conosciuto.
 *       5xx  Google ha RICEVUTO la richiesta e ha fallito nel raccontare come
 *            e' finita. Un 500 su una POST non dimostra che l'evento non sia
 *            stato creato — puo' essere esploso dopo averlo scritto — e
 *            archiviarlo come "nessuna mutazione" butterebbe via l'unica
 *            traccia di un evento che potrebbe esistere davvero.
 *
 * Un 5xx su una LETTURA resta un fallimento pulito: non c'era nessuna
 * mutazione in gioco, quindi non c'e' niente di ignoto da conservare.
 *
 * Ignoto non significa ritentabile automaticamente: la mutazione non viene mai
 * rispedita dal livello HTTP (`retries: 0`). Significa che l'evidenza durevole
 * dice "non lo so", che e' l'unica affermazione onesta.
 */
export function isUnknownCalendarWriteOutcome(error: unknown): boolean {
  if (!(error instanceof AppError)) {
    return false;
  }

  const cause = plainRecord(error.cause);

  if (cause?.[CALENDAR_WRITE_DEADLINE] === 'not_attempted') {
    return false;
  }

  const status = httpStatusFromCause(error.cause);

  if (status !== null) {
    return cause?.[GOOGLE_MUTATION_TRANSMITTED] === true && status >= 500;
  }

  // Timeout e guasti di rete di `fetchWithTimeout` arrivano qui come
  // `upstream_error` senza status HTTP: nessuno dei due dimostra il non-invio.
  return error.code === 'upstream_error';
}

function httpStatusFromCause(cause: unknown): number | null {
  const status = plainRecord(cause)?.status;

  return typeof status === 'number' ? status : null;
}

/**
 * Subordina al budget dell'operazione un'attesa che non e' una fetch.
 *
 * Il consumo del corpo della risposta e' la principale: `fetchWithTimeout`
 * termina quando arrivano gli header, e uno stream che non si chiude piu'
 * terrebbe l'operazione appesa oltre qualunque tetto dichiarato.
 */
async function withCalendarWriteDeadline<T>(
  budget: CalendarWriteBudget,
  label: string,
  work: Promise<T>,
): Promise<T> {
  const remaining = calendarWriteBudgetRemainingMs(budget);

  if (remaining <= 0) {
    throw calendarWriteDeadlineError(label, 'not_attempted');
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    // `Promise.race` si iscrive a entrambi: se il deadline vince per primo, il
    // rigetto tardivo di `work` resta comunque gestito.
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(calendarWriteDeadlineError(label, 'ambiguous')), remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * Legge il corpo di una risposta di scrittura dentro il budget e sotto un
 * tetto di byte.
 */
async function readBoundedJson(response: Response, budget: CalendarWriteBudget): Promise<unknown> {
  const text = await withCalendarWriteDeadline(
    budget,
    'Google Calendar response body',
    readBoundedText(response),
  );

  return parseJsonText(text);
}

async function readBoundedText(response: Response): Promise<string> {
  const body = response.body;

  // Risposta senza stream (204, o `Response` costruita da un buffer): non c'e'
  // niente da limitare incrementalmente.
  if (!body) {
    return await response.text();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > CALENDAR_WRITE_NETWORK.maxResponseBytes) {
        await reader.cancel();

        throw new AppError(
          'upstream_error',
          `Google Calendar response body exceeded ${CALENDAR_WRITE_NETWORK.maxResponseBytes} bytes`,
          { expose: false },
        );
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const merged = new Uint8Array(total);
  let offset = 0;

  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return merged;
}

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

/**
 * Unica porta del BERSAGLIO di una operazione su un evento.
 *
 * Un `calendarId` esplicito e' la provenienza VERIFICATA di un evento gia'
 * scritto, e vince sempre: GET, PATCH e DELETE di un evento storico devono
 * raggiungere il calendario su cui quell'evento vive davvero, non quello che
 * la configurazione nomina adesso. Solo in sua assenza — cioe' per un evento
 * che ancora non esiste — si usa il calendario configurato corrente.
 *
 * La configurazione corrente NON e' provenienza: e' un valore che il tenant
 * puo' cambiare fra la scrittura e la cancellazione. La disponibilita' resta
 * fuori da questa regola: legge il calendario di adesso, che e' esattamente
 * cio' che le serve.
 */
export function effectiveCalendarId(
  integration: GoogleCalendarIntegration,
  explicitCalendarId?: string | null,
): string {
  const explicit = explicitCalendarId?.trim();

  return explicit ? explicit : calendarIdForIntegration(integration);
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
  return parseJsonText(await response.text());
}

function parseJsonText(text: string): unknown {
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

/**
 * `kind` non e' decorazione: e' cio' che permette a chi registra l'esito di
 * distinguere un rifiuto (la richiesta e' stata valutata e respinta) da un
 * guasto del server DOPO la trasmissione di una mutazione.
 */
function googleCalendarError(
  message: string,
  response: Response,
  body: unknown,
  kind: 'read' | 'mutation' = 'read',
): AppError {
  return new AppError('upstream_error', message, {
    cause: {
      status: response.status,
      body,
      ...(kind === 'mutation' ? { [GOOGLE_MUTATION_TRANSMITTED]: true } : {}),
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
