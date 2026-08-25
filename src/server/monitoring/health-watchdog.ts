import { createSupabaseAdminClient } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { AppError } from '@/lib/errors/app-error';
import { logger } from '@/lib/logging/logger';
import {
  CALENDAR_SYNC_MAX_ATTEMPTS,
  CALENDAR_SYNC_URGENT_WINDOW_MS,
} from '@/server/appointments/calendar-convergence';
import { createEmailSender, type EmailSender } from '@/server/notifications/mailer';

/**
 * Sorveglianza dello stato operativo.
 *
 * Il difetto che questo modulo esiste per intercettare è già accaduto: i cron
 * non partivano e l'outbox non veniva mai drenato, quindi nessun messaggio
 * usciva — e non se ne è accorto nessuno finché non è stato letto il codice.
 * Un guasto di questo tipo è silenzioso per costruzione: il sistema risponde
 * 200 su ogni endpoint mentre non fa niente.
 *
 * Il segnale scelto è la coda: se esistono job pronti da inviare, più vecchi di
 * una soglia, significa che qualcosa fra scheduler e worker non sta girando,
 * qualunque sia la causa a monte.
 */

/** Un job pronto da più di questo tempo indica che il worker non sta girando. */
const DEFAULT_STALE_AFTER_MINUTES = 15;

/** Oltre questa soglia la coda è considerata in accumulo anche se recente. */
const DEFAULT_BACKLOG_THRESHOLD = 100;

/**
 * Una riga dovuta da più di questo tempo indica che il reconciler del
 * calendario non sta girando.
 *
 * Il cron gira ogni 5 minuti: mezz'ora sono sei tick mancati, non un ritardo.
 */
const DEFAULT_CALENDAR_STALE_AFTER_MINUTES = 30;

export type WatchdogStatus = 'ok' | 'warning' | 'critical';

/**
 * Segnali sulla proiezione Google Calendar.
 *
 * Sono contati solo sugli appuntamenti FUTURI: un appuntamento passato non
 * sincronizzato non richiede nessuna azione, e includerlo trasformerebbe
 * l'allarme in rumore permanente.
 */
export interface WatchdogCalendarStats {
  /** Righe che hanno esaurito i tentativi: serve un intervento umano. */
  terminalSyncs: number;
  /** Appuntamenti entro 24h già falliti almeno una volta. */
  urgentUnsynced: number;
  /** Righe dovute da troppo tempo: il reconciler stesso non sta girando. */
  staleSyncs: number;
  /**
   * Integrazioni Google attive che portano un guasto permanente di VERIFICA
   * della disponibilita' (PILOT-P0-2).
   *
   * E' una condizione permanente, non un picco: finche' resta, quel tenant non
   * puo' prenotare nulla via WhatsApp, e il sintomo che l'operatore vede — un
   * numero che smette di prendere appuntamenti — e' identico a una giornata
   * tranquilla. Senza questo conteggio il guasto e' invisibile per costruzione.
   */
  availabilityBrokenIntegrations: number;
}

export interface WatchdogReport {
  readonly status: WatchdogStatus;
  readonly checkedAt: string;
  /** Job in attesa di invio (`pending` o `retry`). */
  readonly pendingJobs: number;
  /** Job pronti da più della soglia: il segnale di worker fermo. */
  readonly staleJobs: number;
  /** Job che hanno esaurito i tentativi. */
  readonly deadLetterJobs: number;
  readonly oldestPendingMinutes: number | null;
  readonly calendar: WatchdogCalendarStats;
  readonly reasons: readonly string[];
  readonly notified: boolean;
}

export interface WatchdogQueueStats {
  pendingJobs: number;
  staleJobs: number;
  deadLetterJobs: number;
  oldestPendingAt: string | null;
}

export interface WatchdogRepository {
  readQueueStats(input: { staleBefore: Date }): Promise<WatchdogQueueStats>;
  readCalendarSyncStats(input: {
    now: Date;
    urgentBefore: Date;
    staleBefore: Date;
  }): Promise<WatchdogCalendarStats>;
}

export interface WatchdogOptions {
  readonly staleAfterMinutes?: number;
  readonly calendarStaleAfterMinutes?: number;
  readonly backlogThreshold?: number;
  /** Indirizzo a cui inviare l'allarme. Senza, il watchdog osserva e basta. */
  readonly alertEmail?: string;
  readonly now?: () => Date;
}

export class HealthWatchdogService {
  constructor(
    private readonly repository: WatchdogRepository,
    private readonly emailSender: EmailSender,
    private readonly options: WatchdogOptions = {},
  ) {}

  async check(): Promise<WatchdogReport> {
    const now = this.options.now?.() ?? new Date();
    const staleAfterMinutes = this.options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;
    const backlogThreshold = this.options.backlogThreshold ?? DEFAULT_BACKLOG_THRESHOLD;

    const calendarStaleAfterMinutes =
      this.options.calendarStaleAfterMinutes ?? DEFAULT_CALENDAR_STALE_AFTER_MINUTES;

    const staleBefore = new Date(now.getTime() - staleAfterMinutes * 60_000);
    const stats = await this.repository.readQueueStats({ staleBefore });
    const calendar = await this.repository.readCalendarSyncStats({
      now,
      urgentBefore: new Date(now.getTime() + CALENDAR_SYNC_URGENT_WINDOW_MS),
      staleBefore: new Date(now.getTime() - calendarStaleAfterMinutes * 60_000),
    });

    const oldestPendingMinutes =
      stats.oldestPendingAt === null
        ? null
        : Math.max(0, Math.round((now.getTime() - Date.parse(stats.oldestPendingAt)) / 60_000));

    const reasons: string[] = [];
    let status: WatchdogStatus = 'ok';

    if (stats.staleJobs > 0) {
      // Il caso grave: ci sono messaggi pronti da inviare e nessuno li prende.
      status = 'critical';
      reasons.push(
        `${stats.staleJobs} messaggi in coda da oltre ${staleAfterMinutes} minuti: il worker dell'outbox non sta girando.`,
      );
    }

    if (stats.pendingJobs >= backlogThreshold) {
      status = status === 'critical' ? 'critical' : 'warning';
      reasons.push(
        `${stats.pendingJobs} messaggi in coda: la coda cresce più in fretta di quanto venga drenata.`,
      );
    }

    if (stats.deadLetterJobs > 0) {
      status = status === 'critical' ? 'critical' : 'warning';
      reasons.push(
        `${stats.deadLetterJobs} messaggi hanno esaurito i tentativi e non verranno più inviati.`,
      );
    }

    // I tre segnali sul calendario sono tutti `critical` e non è una svista.
    // Un appuntamento preso con il cliente e assente dal calendario dello
    // studio è un impegno che nessuno vedrà arrivare: non esiste una versione
    // "da guardare con calma" di questo problema.
    if (calendar.terminalSyncs > 0) {
      status = 'critical';
      reasons.push(
        `${calendar.terminalSyncs} appuntamenti futuri non sono sul calendario Google e hanno esaurito i tentativi: vanno inseriti a mano o va ricollegato Google.`,
      );
    }

    if (calendar.urgentUnsynced > 0) {
      status = 'critical';
      reasons.push(
        `${calendar.urgentUnsynced} appuntamenti entro 24 ore non risultano ancora sul calendario Google.`,
      );
    }

    if (calendar.staleSyncs > 0) {
      status = 'critical';
      reasons.push(
        `${calendar.staleSyncs} sincronizzazioni sono in attesa da oltre ${calendarStaleAfterMinutes} minuti: il job di riconciliazione del calendario non sta girando.`,
      );
    }

    if (calendar.availabilityBrokenIntegrations > 0) {
      status = 'critical';
      reasons.push(
        `${calendar.availabilityBrokenIntegrations} integrazioni Google Calendar non riescono piu' a verificare la disponibilita': quei tenant non stanno prendendo appuntamenti su WhatsApp e Google va ricollegato dalla pagina Impostazioni > Integrazioni.`,
      );
    }

    const report: WatchdogReport = {
      status,
      checkedAt: now.toISOString(),
      pendingJobs: stats.pendingJobs,
      staleJobs: stats.staleJobs,
      deadLetterJobs: stats.deadLetterJobs,
      oldestPendingMinutes,
      calendar,
      reasons,
      notified: false,
    };

    if (status === 'ok') {
      logger.info(
        { pendingJobs: stats.pendingJobs, calendarTerminalSyncs: calendar.terminalSyncs },
        'Watchdog: coda in salute',
      );
      return report;
    }

    logger.error(
      {
        status,
        pendingJobs: stats.pendingJobs,
        staleJobs: stats.staleJobs,
        deadLetterJobs: stats.deadLetterJobs,
        oldestPendingMinutes,
        calendarTerminalSyncs: calendar.terminalSyncs,
        calendarUrgentUnsynced: calendar.urgentUnsynced,
        calendarStaleSyncs: calendar.staleSyncs,
        calendarAvailabilityBrokenIntegrations: calendar.availabilityBrokenIntegrations,
      },
      'Watchdog: coda in stato anomalo',
    );

    const notified = await this.notify(report);

    return { ...report, notified };
  }

  /**
   * L'allarme non deve poter far fallire il controllo: un watchdog che va in
   * errore mentre segnala un guasto lascia il sistema senza sorveglianza
   * proprio nel momento in cui serve.
   */
  private async notify(report: WatchdogReport): Promise<boolean> {
    const recipient = this.options.alertEmail;
    if (!recipient) return false;

    const calendarAffected =
      report.calendar.terminalSyncs > 0 ||
      report.calendar.urgentUnsynced > 0 ||
      report.calendar.staleSyncs > 0 ||
      report.calendar.availabilityBrokenIntegrations > 0;
    const subject = calendarAffected
      ? '[Ambrogio] Appuntamenti non sincronizzati con Google Calendar'
      : report.status === 'critical'
        ? '[Ambrogio] I messaggi WhatsApp non stanno uscendo'
        : '[Ambrogio] La coda messaggi richiede attenzione';

    const body = [
      report.status === 'critical'
        ? 'Il sistema non sta consegnando messaggi WhatsApp.'
        : 'La coda dei messaggi WhatsApp mostra segnali di accumulo.',
      '',
      ...report.reasons.map((reason) => `- ${reason}`),
      '',
      `In coda: ${report.pendingJobs}`,
      `Fermi da troppo tempo: ${report.staleJobs}`,
      `Non più ritentabili: ${report.deadLetterJobs}`,
      report.oldestPendingMinutes === null
        ? ''
        : `Messaggio più vecchio in coda: ${report.oldestPendingMinutes} minuti fa`,
      '',
      calendarAffected ? 'Google Calendar:' : '',
      calendarAffected ? `Da inserire a mano: ${report.calendar.terminalSyncs}` : '',
      calendarAffected ? `Entro 24 ore, non sincronizzati: ${report.calendar.urgentUnsynced}` : '',
      calendarAffected ? `In attesa da troppo tempo: ${report.calendar.staleSyncs}` : '',
      report.calendar.availabilityBrokenIntegrations > 0
        ? `Integrazioni da ricollegare (disponibilita' non verificabile): ${report.calendar.availabilityBrokenIntegrations}`
        : '',
      '',
      `Rilevazione: ${report.checkedAt}`,
      '',
      'Gli appuntamenti restano validi e visibili nella dashboard: manca solo la',
      'copia sul calendario Google. Il runbook con le query è in',
      'docs/runbook-calendar-sync.md.',
      report.calendar.availabilityBrokenIntegrations > 0
        ? "Per le integrazioni che non verificano piu' la disponibilita' il runbook è in docs/runbook-calendar-availability.md: la remediation è una riconnessione OAuth dal tenant."
        : '',
      '',
      'Prima cosa da verificare: che i cron della piattaforma stiano effettivamente',
      'invocando /api/internal/jobs/whatsapp-outbox e',
      '/api/internal/jobs/calendar-sync, e che rispondano 200.',
    ]
      .filter((line) => line !== '')
      .join('\n');

    try {
      await this.emailSender.send({
        to: recipient,
        subject,
        text: body,
        html: `<pre>${body.replace(/</g, '&lt;')}</pre>`,
      });
      return true;
    } catch (error) {
      logger.error({ err: error }, 'Watchdog: invio della notifica fallito');
      return false;
    }
  }
}

class SupabaseWatchdogRepository implements WatchdogRepository {
  private readonly supabase = createSupabaseAdminClient();

  async readQueueStats(input: { staleBefore: Date }): Promise<WatchdogQueueStats> {
    const waiting = ['pending', 'retry'];

    const [pending, stale, deadLetter, oldest] = await Promise.all([
      this.supabase
        .from('whatsapp_outbox_jobs')
        .select('id', { count: 'exact', head: true })
        .in('status', waiting),
      this.supabase
        .from('whatsapp_outbox_jobs')
        .select('id', { count: 'exact', head: true })
        .in('status', waiting)
        .lt('next_attempt_at', input.staleBefore.toISOString()),
      this.supabase
        .from('whatsapp_outbox_jobs')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'dead_letter'),
      this.supabase
        .from('whatsapp_outbox_jobs')
        .select('next_attempt_at')
        .in('status', waiting)
        .order('next_attempt_at', { ascending: true })
        .limit(1)
        .maybeSingle(),
    ]);

    const failure = pending.error ?? stale.error ?? deadLetter.error ?? oldest.error;
    if (failure) {
      throw new AppError('internal', 'Failed to read outbox queue stats', { cause: failure });
    }

    return {
      pendingJobs: pending.count ?? 0,
      staleJobs: stale.count ?? 0,
      deadLetterJobs: deadLetter.count ?? 0,
      oldestPendingAt:
        (oldest.data as { next_attempt_at?: string } | null)?.next_attempt_at ?? null,
    };
  }

  /**
   * Tre conteggi sulla stessa tabella degli appuntamenti.
   *
   * `terminalSyncs` usa il predicato di terminalità nella sua forma piena
   * (`failed` e tentativi esauriti) ristretto al futuro: la seconda metà del
   * predicato — `scheduled_at <= now()` — descrive righe su cui non c'è più
   * niente da fare, e allarmarci sopra sarebbe rumore.
   */
  async readCalendarSyncStats(input: {
    now: Date;
    urgentBefore: Date;
    staleBefore: Date;
  }): Promise<WatchdogCalendarStats> {
    const nowIso = input.now.toISOString();
    const waiting = ['pending', 'failed'];

    const [terminal, urgent, stale, availabilityBroken] = await Promise.all([
      this.supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('calendar_provider', 'google_calendar')
        .eq('calendar_sync_status', 'failed')
        .gte('calendar_sync_attempts', CALENDAR_SYNC_MAX_ATTEMPTS)
        .gt('scheduled_at', nowIso),
      this.supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('calendar_provider', 'google_calendar')
        .in('calendar_sync_status', waiting)
        .gte('calendar_sync_attempts', 1)
        .gt('scheduled_at', nowIso)
        .lte('scheduled_at', input.urgentBefore.toISOString()),
      this.supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('calendar_provider', 'google_calendar')
        .in('calendar_sync_status', waiting)
        .not('calendar_sync_next_attempt_at', 'is', null)
        .lt('calendar_sync_next_attempt_at', input.staleBefore.toISOString())
        .lt('calendar_sync_attempts', CALENDAR_SYNC_MAX_ATTEMPTS)
        .gt('scheduled_at', nowIso),
      // Conteggio cross-tenant, senza dati del tenant: al watchdog serve
      // sapere QUANTE integrazioni sono da ricollegare, non quali clienti
      // stiano scrivendo. Solo le `active` contano: una `revoked` e' stata
      // staccata di proposito.
      this.supabase
        .from('integrations')
        .select('id', { count: 'exact', head: true })
        .eq('provider', 'google_calendar')
        .eq('status', 'active')
        .not('availability_error_at', 'is', null),
    ]);

    const failure = terminal.error ?? urgent.error ?? stale.error ?? availabilityBroken.error;

    if (failure) {
      throw new AppError('internal', 'Failed to read calendar sync stats', { cause: failure });
    }

    return {
      terminalSyncs: terminal.count ?? 0,
      urgentUnsynced: urgent.count ?? 0,
      staleSyncs: stale.count ?? 0,
      availabilityBrokenIntegrations: availabilityBroken.count ?? 0,
    };
  }
}

export function createHealthWatchdogService(
  repository: WatchdogRepository = new SupabaseWatchdogRepository(),
  emailSender: EmailSender = createEmailSender(),
  options: WatchdogOptions = {},
): HealthWatchdogService {
  const alertEmail = options.alertEmail ?? env.OPS_ALERT_EMAIL;

  return new HealthWatchdogService(repository, emailSender, {
    ...options,
    ...(alertEmail ? { alertEmail } : {}),
  });
}
