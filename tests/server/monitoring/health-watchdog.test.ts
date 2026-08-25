import { describe, expect, it } from 'vitest';

import {
  HealthWatchdogService,
  type WatchdogCalendarStats,
  type WatchdogErasureStats,
  type WatchdogQueueStats,
  type WatchdogRepository,
} from '@/server/monitoring/health-watchdog';
import type { EmailMessage, EmailSender, EmailSendResult } from '@/server/notifications/mailer';

const NOW = new Date('2026-07-27T12:00:00.000Z');

function repositoryReturning(
  stats: Partial<WatchdogQueueStats>,
  calendar: Partial<WatchdogCalendarStats> = {},
  erasure: Partial<WatchdogErasureStats> = {},
): WatchdogRepository {
  return {
    async readQueueStats() {
      return {
        pendingJobs: 0,
        staleJobs: 0,
        deadLetterJobs: 0,
        oldestPendingAt: null,
        ...stats,
      };
    },
    async readCalendarSyncStats() {
      return {
        terminalSyncs: 0,
        availabilityBrokenIntegrations: 0,
        urgentUnsynced: 0,
        staleSyncs: 0,
        ...calendar,
      };
    },
    async readErasureObligationStats() {
      return {
        pendingObligations: 0,
        manualRequiredObligations: 0,
        ...erasure,
      };
    },
  };
}

function recordingSender(): EmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message: EmailMessage): Promise<EmailSendResult> {
      sent.push(message);
      return { delivered: true, provider: 'resend', providerMessageId: 'msg_1' };
    },
  };
}

/**
 * `alertEmail: null` significa "nessun destinatario configurato".
 * Non si usa `undefined`: passarlo esplicitamente attiverebbe il valore di
 * default del parametro, e il test verificherebbe il contrario di ciò che
 * dichiara.
 */
function makeService(
  repository: WatchdogRepository,
  sender: EmailSender,
  alertEmail: string | null = 'ops@example.com',
): HealthWatchdogService {
  return new HealthWatchdogService(repository, sender, {
    now: () => NOW,
    ...(alertEmail !== null ? { alertEmail } : {}),
  });
}

describe('HealthWatchdogService', () => {
  it('riporta stato ok e non avvisa quando la coda è vuota', async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({}), sender).check();

    expect(report.status).toBe('ok');
    expect(report.notified).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  it('è critico quando esistono job pronti e fermi da troppo tempo', async () => {
    // È esattamente il guasto già accaduto: i cron non partivano, quindi
    // c'erano messaggi pronti che nessun worker prendeva in carico.
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({
        pendingJobs: 12,
        staleJobs: 12,
        oldestPendingAt: '2026-07-27T10:00:00.000Z',
      }),
      sender,
    ).check();

    expect(report.status).toBe('critical');
    expect(report.oldestPendingMinutes).toBe(120);
    expect(report.notified).toBe(true);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.subject).toContain('non stanno uscendo');
  });

  it('segnala la coda in accumulo anche senza job fermi', async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({ pendingJobs: 500 }), sender).check();

    expect(report.status).toBe('warning');
    expect(report.reasons.join(' ')).toContain('500');
    expect(sender.sent).toHaveLength(1);
  });

  it('segnala i messaggi che non verranno più ritentati', async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({ deadLetterJobs: 3 }), sender).check();

    expect(report.status).toBe('warning');
    expect(report.deadLetterJobs).toBe(3);
    expect(report.reasons.join(' ')).toContain('esaurito i tentativi');
  });

  it('la condizione critica prevale su quella di avviso', async () => {
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({ pendingJobs: 500, staleJobs: 1, deadLetterJobs: 9 }),
      sender,
    ).check();

    expect(report.status).toBe('critical');
    expect(report.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('osserva senza avvisare quando non è configurato un destinatario', async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({ staleJobs: 4 }), sender, null).check();

    expect(report.status).toBe('critical');
    expect(report.notified).toBe(false);
    expect(sender.sent).toEqual([]);
  });

  it('non fallisce il controllo se la notifica non parte', async () => {
    // Un watchdog che va in errore mentre segnala un guasto lascia il sistema
    // senza sorveglianza proprio quando serve.
    const failingSender: EmailSender = {
      async send() {
        throw new Error('SMTP down');
      },
    };

    const report = await makeService(repositoryReturning({ staleJobs: 7 }), failingSender).check();

    expect(report.status).toBe('critical');
    expect(report.notified).toBe(false);
  });

  it("avvisa quando un appuntamento futuro non arrivera' mai sul calendario", async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({}, { terminalSyncs: 2 }), sender).check();

    expect(report.status).toBe('critical');
    expect(report.calendar.terminalSyncs).toBe(2);
    expect(report.reasons.join(' ')).toContain('esaurito i tentativi');
    expect(sender.sent[0]?.subject).toContain('Google Calendar');
    // La copia deve dire all'operatore cosa e\' ancora vero: l'appuntamento
    // esiste, manca solo la proiezione.
    expect(sender.sent[0]?.text).toContain('restano validi');
  });

  it("avvisa al primo fallimento quando l'appuntamento e' entro 24 ore", async () => {
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({}, { urgentUnsynced: 1 }),
      sender,
    ).check();

    // Sotto le 24 ore non c'e\' piu\' tempo perche\' se ne accorga qualcuno da solo.
    expect(report.status).toBe('critical');
    expect(report.reasons.join(' ')).toContain('24 ore');
  });

  it("rende visibile un'integrazione Google che non verifica piu' la disponibilita'", async () => {
    // PILOT-P0-2: e' una condizione PERMANENTE, e il sintomo che l'operatore
    // vede da fuori — un numero che smette di prendere appuntamenti — e'
    // identico a una giornata tranquilla. Senza questo conteggio il guasto e'
    // invisibile per costruzione.
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({}, { availabilityBrokenIntegrations: 3 }),
      sender,
    ).check();

    expect(report.status).toBe('critical');
    expect(report.calendar.availabilityBrokenIntegrations).toBe(3);
    // L'operatore deve capire dalla riga stessa qual e' la remediation.
    expect(report.reasons.join(' ')).toContain('ricollegato');
    expect(sender.sent[0]?.text).toContain('runbook-calendar-availability.md');
  });

  it('rende visibile il debito di cancellazione che richiede un operatore', async () => {
    // PILOT-P0-3A: un evento Google con dentro il telefono del cliente che
    // nessun automatismo potra' mai cancellare. Non e' un ritardo: e' un
    // obbligo GDPR aperto che resta aperto finche' non lo chiude una persona.
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({}, {}, { manualRequiredObligations: 2 }),
      sender,
    ).check();

    expect(report.status).toBe('critical');
    expect(report.erasure.manualRequiredObligations).toBe(2);
    expect(sender.sent[0]?.text).toContain('runbook-erasure-obligations.md');
  });

  it('mostra le obbligazioni pending senza allarmare: in P0-3A non sono convergibili', async () => {
    // Il worker remoto arriva in P0-3C. Fino ad allora ogni obbligazione nasce
    // pending e non eseguibile: allarmare qui vorrebbe dire suonare in
    // continuazione per una condizione nota, attesa e non risolvibile — cioe'
    // insegnare all'operatore a ignorare il watchdog.
    const sender = recordingSender();
    const report = await makeService(
      repositoryReturning({}, {}, { pendingObligations: 7 }),
      sender,
    ).check();

    expect(report.erasure.pendingObligations).toBe(7);
    expect(report.status).toBe('ok');
    expect(sender.sent).toEqual([]);
  });

  it('rileva il reconciler del calendario fermo', async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({}, { staleSyncs: 5 }), sender).check();

    // Stessa classe di guasto silenzioso per cui il watchdog esiste: il job
    // non gira e nessuno se ne accorge.
    expect(report.status).toBe('critical');
    expect(report.reasons.join(' ')).toContain('non sta girando');
  });

  it("resta ok quando il calendario e' allineato", async () => {
    const sender = recordingSender();
    const report = await makeService(repositoryReturning({}), sender).check();

    expect(report.status).toBe('ok');
    expect(report.calendar).toEqual({
      terminalSyncs: 0,
      urgentUnsynced: 0,
      staleSyncs: 0,
      availabilityBrokenIntegrations: 0,
    });
    expect(sender.sent).toEqual([]);
  });

  it('usa la finestra di urgenza di 24 ore per il conteggio', async () => {
    const urgentBefore: Date[] = [];
    const repository: WatchdogRepository = {
      async readQueueStats() {
        return { pendingJobs: 0, staleJobs: 0, deadLetterJobs: 0, oldestPendingAt: null };
      },
      async readCalendarSyncStats(input) {
        urgentBefore.push(input.urgentBefore);
        return {
          terminalSyncs: 0,
          urgentUnsynced: 0,
          staleSyncs: 0,
          availabilityBrokenIntegrations: 0,
        };
      },
      async readErasureObligationStats() {
        return { pendingObligations: 0, manualRequiredObligations: 0 };
      },
    };

    await new HealthWatchdogService(repository, recordingSender(), { now: () => NOW }).check();

    expect(urgentBefore[0]?.toISOString()).toBe('2026-07-28T12:00:00.000Z');
  });

  it('usa la soglia di staleness configurata per calcolare il taglio', async () => {
    let received: Date | null = null;
    const repository: WatchdogRepository = {
      async readQueueStats(input) {
        received = input.staleBefore;
        return { pendingJobs: 0, staleJobs: 0, deadLetterJobs: 0, oldestPendingAt: null };
      },
      async readCalendarSyncStats() {
        return {
          terminalSyncs: 0,
          urgentUnsynced: 0,
          staleSyncs: 0,
          availabilityBrokenIntegrations: 0,
        };
      },
      async readErasureObligationStats() {
        return { pendingObligations: 0, manualRequiredObligations: 0 };
      },
    };

    await new HealthWatchdogService(repository, recordingSender(), {
      now: () => NOW,
      staleAfterMinutes: 30,
    }).check();

    expect(received).not.toBeNull();
    expect((received as unknown as Date).toISOString()).toBe('2026-07-27T11:30:00.000Z');
  });
});
