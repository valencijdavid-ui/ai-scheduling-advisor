# Cancellazione GDPR — invarianti congelate

Stato: **PILOT-P0-3A implementata**. P0-3B e P0-3C **mancano** e sono
bloccanti per il pilota.

Questo documento registra le decisioni che il codice da' per scontate. Non
descrive come si usa il sistema (per quello c'e'
[runbook-erasure-obligations.md](../runbook-erasure-obligations.md)): descrive
cosa non si puo' cambiare senza rompere una garanzia.

## Il difetto di partenza (F3)

La cancellazione dei dati di un cliente eseguiva cinque DELETE indipendenti via
PostgREST, nell'ordine sbagliato: prima i messaggi, poi le conversazioni. La
seconda cancellazione falliva con `23503` su
`appointments_conversation_id_fkey` — la FK e' `NO ACTION`
(`202604240001_initial_backend_mvp.sql:132`) e l'appuntamento puntava ancora
alla conversazione.

Esito: messaggi distrutti e committati, conversazione e appuntamento vivi,
nessun audit scritto, nessun rollback possibile. Riproducibile su Postgres
reale; la caratterizzazione e' conservata come test
(`tests/server/gdpr/erasure-core.pg.test.ts`).

La correzione sta nell'**ordine dentro una transazione**, non in una modifica
dello schema: il vincolo resta `NO ACTION` e il test lo verifica, perche'
cambiare una migration gia' applicata in produzione sarebbe un'altra classe di
rischio.

## Invarianti

### 1. La cancellazione locale e' una transazione sola

`public.erase_customer_data` fa tutto: risoluzione dell'identita', cattura del
debito remoto, cancellazioni, audit. O commit, o rollback. Nessuna rete dentro
la transazione — una chiamata HTTP la terrebbe aperta per tutta la durata della
richiesta remota.

Gli appuntamenti si cancellano **prima** delle conversazioni. I messaggi
seguono per `ON DELETE CASCADE`.

### 2. Il debito remoto sopravvive alla riga che lo ha generato

`erasure_obligations.tenant_ref` e' un **UUID nudo, senza foreign key**, ed e'
la decisione piu' importante della tabella.

Ogni tabella tenant-scoped e' `ON DELETE CASCADE`. Una FK verso `tenants` farebbe
sparire l'obbligazione **esattamente nell'istante** in cui il tenant viene
hard-deleted — cioe' l'istante in cui si perde per sempre l'autorita' per
cancellare l'evento remoto. Il vincolo e' verificato da un test e presidiato da
`npm run db:lint`.

### 3. Nessuna credenziale, nessun dato del cliente nell'obbligazione

La tabella non ha colonne capaci di contenerli, e un test lo verifica sul testo
della migration. Il worker di P0-3C leggera' le credenziali **correnti**
tramite `tenant_ref`; se non esistono piu', l'obbligazione diventa
`manual_required`.

### 4. `calendar_event_id` NULL significa IGNOTO

Mai "gia' pulito". L'evento puo' esistere su Google senza che noi ne conosciamo
l'id, e non e' ricostruibile a posteriori. Diventa `manual_required`.

### 5. Il worker usera' il `calendar_id` catturato

Non la configurazione corrente dell'integrazione. Il tenant puo' cambiare
calendario, e una riconnessione rimette `primary`: un DELETE mandato al
calendario sbagliato riceve `404`, che per `cancelEvent` e' **successo
idempotente**. L'obbligazione risulterebbe chiusa e l'evento — con dentro il
telefono del cliente — resterebbe vivo altrove.

Per questo esiste `appointments.calendar_event_calendar_id`: da P0-3C sara'
popolata a ogni sync riuscito. Per le righe legacy resta NULL e la cattura
ricade sulla configurazione corrente — limite noto, coperto dal **gate
pre-pilot** sulla storia del calendario, non risolvibile a posteriori.

**Ma un calendario ignoto non viene mai inventato.** La cattura ha tre esiti, e
dipendono da due cose sole: se l'appuntamento ha una provenienza registrata, e
se il tenant ha ancora un'integrazione `google_calendar` **attiva** (l'autorita'
per cancellare).

| Provenienza | Autorita' | `status` | `calendar_id` |
|---|---|---|---|
| presente | si' | `pending` | provenienza registrata |
| assente | si' | `pending` | calendario corrente dell'integrazione |
| presente | no | `manual_required` | provenienza registrata (serve a chi rimedia) |
| assente | no | `manual_required` | **NULL** |

L'ultima riga e' il punto. Scrivere `primary` per far passare il vincolo di
schema produrrebbe una riga che *sembra* eseguibile: P0-3C la cancellerebbe sul
calendario sbagliato, prenderebbe 404, e il 404 vale successo idempotente. Il
debito si chiuderebbe e l'evento resterebbe vivo. Per questo il vincolo
`erasure_obligations_executable_needs_calendar` ammette `external_event_id` con
`calendar_id` NULL **solo** negli stati che nessun automatismo prende in carico
(`manual_required`, `voided`), e lo vieta in `pending` / `scheduled` /
`converged`.

Perdere l'autorita' significa `manual_required` **anche quando il calendario e'
noto**: conoscere l'indirizzo non e' avere la chiave.

### 5b. Un oggetto remoto, un debito

Niente vieta a due righe di `appointments` di puntare allo stesso
`calendar_event_id` — non c'e' vincolo unico, e i dati legacy o importati non
rispettano le assunzioni dei percorsi di scrittura attuali. La cattura
deduplica quindi sull'**identita' remota** (`calendar_id` + `external_event_id`),
non sull'appuntamento, e i conteggi riportati sono obbligazioni catturate, non
appuntamenti che le hanno generate.

Non e' un'ottimizzazione: senza dedup l'UPSERT multi-riga tocca due volte la
stessa obbligazione, Postgres solleva `21000`, e la transazione rollbacca
pulita — ma ogni ritentativo fallisce identico. La cancellazione di quel cliente
diventerebbe **impossibile per sempre**.

Aggiungere ora un vincolo unico su `appointments.calendar_event_id` sarebbe la
correzione sbagliata: romperebbe dati che esistono gia'.

### 6. Cancellazione locale ≠ convergenza remota

L'API riporta due esiti separati, e restano separati per costruzione:

- `localDeletion`: `complete` | `manual_review_required`
- `remoteCleanup`: `not_required` | `pending` | `manual_required`

`localDeletion` vale `complete` **solo** se `residualSuspected` e' zero. Se sono
rimaste righe che potrebbero essere lo stesso soggetto sotto un altro prefisso,
vale `manual_review_required`: la transazione ha committato, ma la cancellazione
locale non e' finita — ha finito solo la parte che si poteva fare da sola.
Titolare quella risposta `complete` e lasciare la verita' in un contatore in
fondo al payload significa sapere che nessuno la leggera'.

E' un'unione e non un flag booleano di proposito: cosi' nessun consumatore puo'
leggere l'esito senza incontrare anche il caso da gestire.

Le due dimensioni **non si sommano e non si sostituiscono**: l'ambiguita' di
identita' locale si chiude rileggendo l'anagrafica, il debito remoto si chiude
cancellando un evento su Google. Una richiesta puo' essere `complete` in locale
e `pending` in remoto, o il contrario.

**Non esiste il valore "completato"**: in P0-3A nessuno converge il debito
remoto, quindi dichiararlo concluso sarebbe una bugia. Lo stato peggiore vince:
se anche una sola obbligazione e' `manual_required`, l'esito complessivo e'
`manual_required`, perche' `pending` lascerebbe credere che basti aspettare.

### 7. Confronto per cifre esatte, mai per suffisso

La cancellazione automatica confronta solo cifre normalizzate **uguali**. Un
numero nazionale e uno con prefisso internazionale non sono automaticamente la
stessa persona: cancellare su quella base distruggerebbe i dati di un altro
cliente. I possibili alias vengono **rilevati** e contati
(`residualSuspected`), mai cancellati.

La normalizzazione avviene **dentro** la primitiva SQL, non solo nella route: i
percorsi di scrittura salvano il numero con la formattazione ricevuta.

### 8. L'audit non conserva l'identita' del soggetto

`audit_log` e' progettato per sopravvivere alla cancellazione del tenant
(`tenant_id ON DELETE SET NULL`). Conservarci `customerPhone` significava
tenere in chiaro, per sempre, proprio l'identificativo che le azioni GDPR
avevano il compito di trattare.

Rimosso da `gdpr.customer.deletion.executed` **e** da
`gdpr.customer.export.requested`, con bonifica idempotente dello storico. La
correlazione avviene tramite `requestId`. Nessun nuovo segreto crittografico e'
stato introdotto: un fingerprint con chiave avrebbe aggiunto rotazione e
superficie di fuga senza soddisfare un requisito che non fosse gia' coperto.

### 9. La richiesta e' ripetibile e non rivela l'esistenza del cliente

Zero righe non e' piu' `404`. Serve a due cose: non permettere di enumerare
quali numeri esistono nel tenant, e permettere all'operatore di ripetere una
richiesta la cui risposta HTTP si e' persa — senza obbligarci a conservare
un'impronta del cliente per riconoscerlo.

## Confine di fase

**P0-3A cattura il debito remoto. NON lo esegue.**

Non esistono worker, cron o route che cancellino eventi su Google. Ogni
obbligazione nasce `pending` con `next_attempt_at = NULL`, cioe' non eseguibile.
Il confine e' verificato da `tests/server/gdpr/erasure-no-remote-execution.test.ts`,
che fallisce nel momento in cui qualcuno collega un esecutore alla tabella.

Il motivo e' una race reale: uno scrittore P0-1 in volo puo' ricreare l'evento
subito dopo la cancellazione, e il debito risulterebbe chiuso mentre l'evento e'
vivo. Chiudere quella race richiede un bound provabile sulla durata di ogni
percorso di scrittura Google — che **oggi non esiste** (vedi sotto).

## Debito noto consegnato a P0-3C

Il percorso di scrittura Google **non ha nessun bound finito applicabile**:

- `getEvent`, `createEvent`, `updateEvent`, `cancelEvent` e il refresh del token
  usano `this.fetcher` diretto, senza timeout ne' `AbortSignal`
  (`src/server/calendar/google.ts`);
- `fetchWithTimeout` e' applicato **solo** al percorso disponibilita' (3s), e il
  commento su `getAccessToken` dichiara esplicito che quel budget non deve poter
  accorciare una scrittura;
- nessun `maxDuration` e' dichiarato (`vercel.json`, route segment config,
  `next.config.ts`);
- il `Dockerfile` esegue `node server.js`: sul self-host non esiste nessun
  tetto di durata.

`CALENDAR_SYNC_LEASE_MS` **non** e' quel bound: e' tempo di ri-claim, non durata
di esecuzione, e il sync inline del percorso di prenotazione non e' governato
dal lease.

P0-3C deve stabilire questo contratto **prima** di rendere eseguibile il worker.

## Cosa resta bloccante per il pilota

| Fase | Contenuto |
|---|---|
| **P0-3B** | Grace period e finalizzazione del tenant, disconnect Google |
| **P0-3C** | Convergenza remota, fence pre-scrittura, backstop post-scrittura |
| **P0-4** | Media vocali su Supabase Storage |
| **P0-5** | `webhook_events`, `contact_submissions`, PII residua |
| **P0-6** | Testi legali allineati all'implementazione |

**P0-3A da solo non e' pilot-complete.**

### Carve-in gia' fatto in P0-3A

`voice_events` e `scheduling_decisions` vengono cancellate **dentro** questa
transazione, pur essendo materia di P0-5. Le loro FK sono `ON DELETE SET NULL`:
cancellando prima i genitori resterebbero orfane, con dentro contenuto del
cliente e nessun modo di ricondurle a lui. Non e' rimandabile — e' l'ultimo
momento in cui sono indirizzabili.

`webhook_events` e `contact_submissions` restano invece a P0-5: sono
indirizzabili anche dopo, per contenuto.

## Trovato durante P0-3A, NON corretto qui

Due difetti emersi mentre si verificava P0-3A su PostgreSQL reale. Nessuno dei
due e' materia di questa fase e nessuno dei due e' stato toccato: allargare
P0-3A per assorbirli avrebbe reso non verificabile quello che P0-3A doveva
dimostrare. Sono registrati qui perche' non si perdano.

### P0-7 — il vincolo di anti-sovrapposizione non esiste

`appointments_no_confirmed_overlap` (in `202604240001_initial_backend_mvp.sql`)
indicizza `scheduled_at + duration_minutes * interval '1 minute'`. Su
`timestamptz` quell'espressione e' `STABLE`, non `IMMUTABLE`, e PostgreSQL
rifiuta di indicizzarla:

```
ERROR:  functions in index expression must be marked IMMUTABLE
```

Verificato su PostgreSQL 16.14. L'`ALTER TABLE` vive dentro un blocco `do $$`,
quindi l'errore **aborta l'intero file di migration**: lo statement successivo
non viene eseguito.

Due conseguenze, entrambe da caratterizzare prima del pilota:

1. una catena di migration applicata da zero **si ferma** su quel file;
2. il vincolo **non esiste in nessun database gia' deployato**, quindi la
   garanzia di non-sovrapposizione a livello di database non c'e' — resta solo
   quella applicativa.

Il test harness di P0-3A salta deliberatamente quel blocco. Il salto non altera
niente di P0-3A: un vincolo di esclusione non viene mai valutato su `DELETE`, e
l'unico `UPDATE` della transazione non tocca nessuna delle colonne della chiave
del vincolo.

**Non modificare la migration storica.** La correzione e' P0-7.

### P0-5 — il cron di retention ripete F3

`src/server/gdpr/data-retention.ts` cancella `messages` e poi `conversations` in
chiamate separate e gia' committate: **la stessa sequenza di F3**, ma
cross-tenant e su un cron notturno. `appointments.conversation_id` e'
`NO ACTION` e gli appuntamenti non vengono mai fatti scadere, quindi appena una
conversazione abbastanza vecchia porta ancora un appuntamento, la cancellazione
delle conversazioni prende `23503` — con i messaggi gia' distrutti.

Lo stesso file cancella `voice_events` **dopo** `messages`: il cascade azzera
prima `voice_events.message_id`, ed e' esattamente la perdita di aggancio che la
transazione di P0-3A evita al suo interno.

Non e' un guasto latente indefinito: diventa attivo quando le conversazioni piu'
vecchie del pilota superano la soglia di retention.

**Non modificato in questo branch.** Diventa un requisito esplicito di P0-5.
