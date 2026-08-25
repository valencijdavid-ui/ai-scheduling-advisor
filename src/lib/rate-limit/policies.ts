/**
 * Definizione centralizzata delle policy di rate limit dell'applicazione.
 *
 * Ogni policy specifica:
 * - `window`: finestra temporale in **secondi**.
 * - `limit`: numero massimo di richieste consentite in quella finestra.
 *
 * Le policy sono nominate per intent (es. `authLogin`, `onboarding`)
 * cosi' che chi applica un rate limit non si accoppi a numeri magici
 * sparsi nel codebase.
 */
export type RateLimitPolicy = {
  /** Finestra in secondi. */
  readonly window: number;
  /** Numero massimo di tentativi nella finestra. */
  readonly limit: number;
};

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RATE_LIMIT_POLICIES = {
  /** Login Supabase via route custom (5 tentativi / 15 min). */
  authLogin: { window: 15 * MINUTE, limit: 5 },
  /** Reset password (3 / ora). */
  authPasswordReset: { window: 1 * HOUR, limit: 3 },
  /** Magic link (3 / ora). */
  authMagicLink: { window: 1 * HOUR, limit: 3 },
  /** Onboarding tenant (10 / ora per utente). */
  onboarding: { window: 1 * HOUR, limit: 10 },
  /** Scrittura settings (30 / minuto per tenant). */
  settingsWrite: { window: 1 * MINUTE, limit: 30 },
  /** Export GDPR (1 / 24h). */
  gdprExport: { window: 1 * DAY, limit: 1 },
  /** Chiusura account tenant (1 / 24h). Irreversibile, ne basta una. */
  gdprDelete: { window: 1 * DAY, limit: 1 },
  /**
   * Cancellazione GDPR di un cliente finale (20 / ora per utente).
   *
   * Deliberatamente separata da `gdprDelete`, per due ragioni.
   *
   * La prima e' che condividere la chiave significava condividere il budget:
   * cancellare un cliente consumava la possibilita' di chiudere l'account del
   * tenant per 24 ore, e viceversa. Sono due diritti diversi, non due usi
   * dello stesso.
   *
   * La seconda e' che 1/24h contraddiceva il servizio che limita. La
   * cancellazione customer e' stata resa ripetibile apposta, perche' se la
   * risposta HTTP si perde l'operatore deve poter ripetere senza che il
   * sistema conservi un'impronta del cliente per riconoscere il tentativo; un
   * limite da una richiesta al giorno rendeva quella ripetizione impossibile.
   * E uno studio che riceve tre richieste Art. 17 in una settimana non puo'
   * onorarne una al giorno.
   *
   * Resta stretta abbastanza da contare: 20 all'ora non e' il ritmo con cui si
   * svuota un'anagrafica da una sessione admin rubata.
   */
  gdprCustomerErasure: { window: 1 * HOUR, limit: 20 },
  /** Contact form pubblico (5 / minuto per IP, anti-spam). */
  contactForm: { window: 1 * MINUTE, limit: 5 },
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitPolicyKey = keyof typeof RATE_LIMIT_POLICIES;
