// Fatto da Claude Code il 8 maggio 2026.
//
// Zod schemas per i payload Google OAuth + Calendar utilizzati dal backend.
//
// Tutti gli schemi usano `.passthrough()` perché Google espande i payload con
// nuovi campi senza preavviso e non vogliamo rifiutare risposte valide solo
// perché contengono campi extra.

import { z } from 'zod';

/**
 * Risposta di /token (sia authorization_code grant che refresh_token grant).
 *
 * Google ritorna `error`/`error_description` quando il grant fallisce, e
 * `access_token`/`refresh_token` quando ha successo. `expires_in` è in secondi.
 */
export const GoogleOAuthTokenResponseSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
    error: z.string().optional(),
    error_description: z.string().optional(),
    id_token: z.string().optional(),
  })
  .passthrough();

export type GoogleOAuthTokenResponse = z.infer<typeof GoogleOAuthTokenResponseSchema>;

/**
 * Risposta di /freeBusy.
 *
 * Mappa `calendarId -> { busy: [...] }`. Google può includere `errors[]` se
 * un calendario non è accessibile.
 */
export const GoogleFreeBusyResponseSchema = z
  .object({
    calendars: z
      .record(
        z.string(),
        z
          .object({
            errors: z
              .array(
                z
                  .object({
                    domain: z.string().optional(),
                    reason: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
            busy: z
              .array(
                z
                  .object({
                    start: z.string().optional(),
                    end: z.string().optional(),
                  })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type GoogleFreeBusyResponse = z.infer<typeof GoogleFreeBusyResponseSchema>;

/**
 * Estremo temporale di un evento Google.
 *
 * Google usa `dateTime` per gli eventi con orario e `date` per quelli
 * all-day: gli appuntamenti sono sempre del primo tipo, ma la convergenza
 * deve saper riconoscere il secondo caso come divergenza invece di
 * ignorarlo silenziosamente.
 */
export const GoogleCalendarEventDateTimeSchema = z
  .object({
    dateTime: z.string().optional(),
    date: z.string().optional(),
    timeZone: z.string().optional(),
  })
  .passthrough();

/**
 * Subset della risposta di GET/POST/PATCH events.
 *
 * Oltre a `id` e `htmlLink` leggiamo `status`, `start` e `end`: sono i campi
 * che la routine di convergenza confronta con Postgres per decidere se
 * l'evento remoto e' gia' allineato. Senza `status` non potremmo distinguere
 * un evento attivo da una tombstone `cancelled`, che Google continua a
 * restituire su GET per id.
 */
export const GoogleCalendarEventResponseSchema = z
  .object({
    id: z.string().optional(),
    htmlLink: z.string().optional(),
    status: z.string().optional(),
    start: GoogleCalendarEventDateTimeSchema.optional(),
    end: GoogleCalendarEventDateTimeSchema.optional(),
  })
  .passthrough();

export type GoogleCalendarEventResponse = z.infer<typeof GoogleCalendarEventResponseSchema>;

/**
 * Parser sicuro: ritorna lo schema risultato o un fallback "minimal" che
 * preserva i campi unknown originali. Usato per interpretare body JSON
 * semi-strutturati (es. errori).
 */
function safeParseOrEmpty<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  return (result.success ? result.data : {}) as z.infer<T>;
}

export function parseGoogleTokenResponse(value: unknown): GoogleOAuthTokenResponse {
  return safeParseOrEmpty(GoogleOAuthTokenResponseSchema, value);
}

export function parseGoogleFreeBusyResponse(value: unknown): GoogleFreeBusyResponse {
  return safeParseOrEmpty(GoogleFreeBusyResponseSchema, value);
}

export function parseGoogleCalendarEventResponse(value: unknown): GoogleCalendarEventResponse {
  return safeParseOrEmpty(GoogleCalendarEventResponseSchema, value);
}

// ---------------------------------------------------------------------------
// freeBusy: percorso di parsing STRETTO (PILOT-P0-2)
// ---------------------------------------------------------------------------
//
// `parseGoogleFreeBusyResponse` resta lenient e resta invariato: e' il parser
// usato per leggere body semi-strutturati, inclusi quelli d'errore, dove
// pretendere lo schema di successo significherebbe perdere l'informazione
// utile.
//
// La disponibilita' ha bisogno del contrario. Un 200 che non rispetta lo
// schema, letto con `safeParseOrEmpty`, diventa `{}` e quindi `busy: []`: cioe'
// "calendario libero". E' esattamente la trasformazione che PILOT-P0-2 esiste
// per impedire, perche' produce prenotazioni sopra impegni reali.
//
// Percio' qui gli estremi `start`/`end` sono OBBLIGATORI: un intervallo busy
// senza orari non e' un intervallo da ignorare, e' una risposta che non
// sappiamo leggere.

const GoogleFreeBusyStrictCalendarSchema = z
  .object({
    errors: z
      .array(
        z
          .object({
            domain: z.string().optional(),
            reason: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
    busy: z
      .array(
        z
          .object({
            start: z.string().min(1),
            end: z.string().min(1),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

/**
 * `.passthrough()` resta: Google aggiunge campi senza preavviso e rifiutare
 * una risposta valida perche' contiene campi nuovi sarebbe un fail-closed
 * autoinflitto. La strettezza riguarda i campi che sappiamo servire.
 */
export const GoogleFreeBusyStrictResponseSchema = z
  .object({
    calendars: z.record(z.string(), GoogleFreeBusyStrictCalendarSchema),
  })
  .passthrough();

export type GoogleFreeBusyStrictResponse = z.infer<typeof GoogleFreeBusyStrictResponseSchema>;

export type GoogleFreeBusyStrictParseResult =
  | { success: true; data: GoogleFreeBusyStrictResponse }
  | { success: false; issue: string };

/**
 * Non lancia e non ritorna un fallback vuoto: ritorna un esito che il
 * chiamante e' obbligato a distinguere.
 */
export function parseGoogleFreeBusyResponseStrict(value: unknown): GoogleFreeBusyStrictParseResult {
  const result = GoogleFreeBusyStrictResponseSchema.safeParse(value);

  if (result.success) {
    return { success: true, data: result.data };
  }

  const first = result.error.issues[0];

  return {
    success: false,
    issue: first
      ? `${first.path.join('.') || 'response'}: ${first.message}`
      : 'invalid freeBusy response',
  };
}
