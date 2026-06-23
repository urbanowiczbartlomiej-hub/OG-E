# ToolDev consult — fleet-return "alarm clock" (record)

> **Transient doc** (per CLAUDE.md's "plan docs have a lifecycle"): delete once
> the reminders question is ruled on and folded into the submission. Git keeps
> the history. Companion to [`fair-play.md`](fair-play.md) (the RED on the ntfy
> push) and [`toleration-plan.md`](toleration-plan.md) (the overall plan).

## Status

- **Posted:** 2026-06-23 — forum thread **#516**, *Community Projects →
  Submissions/Development*:
  <https://forum.origin.ogame.gameforge.com/forum/thread/516-pre-submission-consult-is-a-fleet-return-alarm-clock-feature-within-fair-play/>
- **Outcome — APPROVED (conditional), 2026-06-23.** ToolDevs agreed the "alarm
  clock" argument holds, while noting their intent is that players manage their
  own time without tools, and that even a phone alarm is a soft edge; they also
  flagged that ntfy may simply fail (offline / no signal / not registered),
  which we should not present as a guarantee. Manual time-entry was floated but
  **not** made a condition. **The one binding condition: OG-E must NEVER track
  the game while the player is not present.** Reminders are **kept** (ntfy push
  stays) — no need to drop fleet-save / guardian.
- **Implemented (condition now true in code):** `313545c` (Tier 1 — alarmClock
  producer + threatHighlight stop reading the game while `document.hidden`,
  reconcile/snap on return) and `07268c7` (Tier 2 — every cosmetic game-DOM
  observer gated via `lib/visibilityObserver.js`). Plus the framing renames
  `reminders`→`alarmClock` (`ddd1552`) and `attackAlarm`→`threatHighlight`
  (`d35651d`).
- **Framing of the question:** deliberately **anonymous + forward-looking** — it
  asked about the *act itself*, not OG-E specifically.

---

## Discord `#tooldevs-chat` — short pointer (EN, fits the 2000-char chat limit)

> Hi 👋 — a pre-submission fair-play question I'd like to clear with you
> **before** building it.
>
> In short: would a feature that lets a player set a **one-shot phone reminder
> for the return time of their own fleet/expedition** — a time they already
> know, since they sent it — be within fair-play? It's effectively an alarm
> clock (a time the player could just type into their phone manually): once set
> it **watches nothing**, never monitors the game, never reacts to live events,
> and never tracks hostile fleets or attacks.
>
> I've written up the full rationale — honestly **for and against**, including
> that the *Forbidden features* post by RiV- addresses this category fairly
> explicitly — here:
> https://forum.origin.ogame.gameforge.com/forum/thread/516-pre-submission-consult-is-a-fleet-return-alarm-clock-feature-within-fair-play/
>
> I'd really appreciate your opinion on whether the **act itself** crosses the
> line, or under what narrowed scope it could be acceptable. If it isn't, we'll
> keep it **in-tab only** and deliver nothing off-game. Thanks 🙏

---

## Forum thread — full text (EN, as posted)

**Pre-submission consult — is a "fleet-return alarm clock" feature within fair-play?**

Hi ToolDevs,

**Context of this question.** We are considering adding a borderline feature to
a tool and — following the principle of not investing work into features that
might not be tolerated — we would like your opinion **before** we build it. We
want to be fully honest, so we present the arguments both for and against,
including what we believe may be the game designer's intent.

**Goal and value of the feature.** OGame today is largely played on mobile — a
player performs an action, then puts the phone away and goes about their day.
The return of a fleet or expedition happens at a time that is **fully determined
and known to the player the moment they send it**. The feature would have a
single purpose: to help a player **not miss their own, already-known time** —
purely as a matter of personal organization. It reveals no information the
player doesn't already have, changes no game mechanic, involves no interaction
with other players, and grants no intelligence or tactical advantage. It is
convenience and accessibility, especially for those playing on a phone.

**How it works (technically, without sugar-coating).** The player marks a
specific row, with a specific time, in the event list (or the feature
recognizes the return of their own fleet), and the tool reads that
already-known time and registers it as a **delayed message** in a public
push-notification service (e.g. ntfy.sh). The service holds the message on its
side and delivers it at the set time. **Once it is set, the tool observes
nothing** — while the player is away it does not look at the game, does not
react to live events, and **never tracks hostile fleets or attacks**. It is a
one-shot, pre-set timer, not a monitor.

**Line of defense (for).** Functionally, this is **an alarm clock for a time the
player could just as well enter manually** into their phone's clock app. It is
derived solely from the player's own action and concerns only the player's own,
already-known times. There is no background monitoring, no reacting to events,
and no attack alerting of any kind. Mechanically it is closer to a "set alarm"
than to a reactive ping (e.g. on Discord) that would watch the game and notify
at the moment of an event. From the player's perspective it is purely a
convenience that helps them keep to **their own** schedule — nothing more.

**Argument against — and the likely intent of the game's creator (honestly).**
We are aware that the game's very design may assume that **the player is
supposed to remember their own flight times themselves** — that the discipline
of presence and memory is **part of the gameplay**, not an inconvenience to be
removed by a tool. In that light, **even a classic, manually-set phone alarm**
is a kind of circumvention of the creator's intent. And this feature goes one
step further: it is **the tool**, not the player's memory, that reads a specific
time from the game's interface and turns it into an **automated notification
delivered outside the game, while the player is away from it**.

Moreover, we are fully aware that the **"Forbidden features" post — whose
substantive text was written by RiV- (ToolDevs Admin) — addresses this category
fairly explicitly**, naming notifications about fleet arrivals delivered as a
push / via external webhooks while the player is away. So we are not pretending
the rules are silent on this. We are only asking whether our "alarm clock"
framing — derived **solely from the player's own action** and involving no
monitoring whatsoever — changes that assessment at all, or not.

**The question we are really asking.** Does the **act itself** — marking a
specific record, with a specific time, from the event list as "an alarm for that
hour," which translates into registering that time as a delayed push
notification — **fall within your accepted fair-play strategy, or does it
already cross it?** Regardless of the fact that it is an alarm clock and concerns
the player's own fleet. In other words: could such a feature receive your
approval to be implemented, and if so, under what conditions or in what narrowed
scope?

**An honest closing.** We realize this raises doubts, and we **do not want to
decide it ourselves or assume a favorable interpretation**. If you consider the
feature impermissible, we simply will not implement it as off-game
notifications — we will limit ourselves to in-tab signaling within the active
game tab only. Thank you in advance for your opinion.

---

## Wątek — pełna treść (PL, wersja robocza / referencyjna)

**Pytanie do konsultacji — dopuszczalność funkcji „budzika" na powrót własnej floty**

**Kontekst pytania.** Rozważamy dodanie do narzędzia pewnej funkcji granicznej
i — zgodnie z zasadą, by nie wkładać pracy w funkcje, które mogłyby nie zostać
dopuszczone — chcemy **najpierw** poznać Waszą opinię, zanim ją zrealizujemy.
Zależy nam na pełnej uczciwości, dlatego przedstawiamy zarówno argumenty za, jak
i przeciw, łącznie z prawdopodobną intencją twórcy gry.

**Cel i wartość funkcji.** OGame jest dziś w dużej mierze grą mobilną — gracz
wykonuje akcję, po czym odkłada telefon i wraca do innych zajęć. Powrót floty
czy ekspedycji następuje o czasie, który jest **w pełni zdeterminowany i znany
graczowi już w chwili wysłania**. Funkcja miałaby jeden cel: pomóc graczowi
**nie przegapić jego własnego, znanego z góry czasu** — czysto organizacyjnie.
Nie odsłania żadnej informacji, której gracz już by nie miał, nie zmienia żadnej
mechaniki gry, nie wchodzi w interakcję z innymi graczami i nie daje przewagi
wywiadowczej ani taktycznej. To wygoda i dostępność, szczególnie dla grających
na telefonie.

**Forma działania (technicznie, bez upiększania).** Gracz wskazuje konkretny
wiersz o konkretnym czasie na liście zdarzeń (lub funkcja rozpoznaje powrót jego
własnej floty), a narzędzie odczytuje ten znany z góry czas i rejestruje go jako
**opóźnioną wiadomość** w publicznej usłudze powiadomień push (np. ntfy.sh). To
usługa przetrzymuje wiadomość po swojej stronie i dostarcza ją o zadanej
godzinie. **Po ustawieniu narzędzie niczego nie obserwuje** — gdy gracza nie ma,
nie patrzy na grę, nie reaguje na zdarzenia na żywo i **nigdy nie śledzi wrogich
flot ani ataków**. To jednorazowy, nastawiony zegar, nie monitor.

**Linia obrony (za).** Funkcjonalnie jest to **budzik na czas, który gracz mógłby
równie dobrze wpisać ręcznie** w aplikację zegara w telefonie. Wynika wyłącznie z
jego własnej akcji i dotyczy wyłącznie jego własnych, znanych z góry czasów. Nie
ma tu monitoringu w tle, reagowania na zdarzenia ani jakiegokolwiek ostrzegania o
atakach. Pod względem mechanizmu jest to bliżej „nastawionego budzika" niż
reaktywnego pinga (np. na Discord), który obserwowałby grę i powiadamiał w chwili
zdarzenia. Z perspektywy gracza to wyłącznie udogodnienie, które pomaga mu
trzymać się **własnego** harmonogramu — nic ponadto.

**Argument przeciw — i prawdopodobna intencja twórcy gry (uczciwie).** Mamy
świadomość, że sama idea gry może zakładać, iż **to gracz musi sam pamiętać**
czasy swoich lotów — że dyscyplina obecności i pamięci jest **częścią
rozgrywki**, a nie uciążliwością do wyeliminowania przez narzędzie. W tym świetle
**nawet klasyczny budzik w telefonie**, ustawiany ręcznie, jest pewnego rodzaju
obejściem intencji twórcy. A omawiana funkcja idzie o krok dalej: to
**narzędzie**, a nie pamięć gracza, odczytuje konkretny czas z interfejsu gry i
zamienia go w **automatyczne powiadomienie dostarczane poza grę, gdy gracza przy
niej nie ma**.

Co więcej, mamy pełną świadomość, że **wpis „Forbidden features" — którego
merytoryczną treść napisał RiV- (ToolDevs Admin) — odnosi się do tej kategorii
dość wyraźnie**, wymieniając powiadomienia o powrotach flot dostarczane jako push
/ przez zewnętrzne webhooki, gdy gracza nie ma. Nie udajemy więc, że zasady o tym
milczą. Pytamy jedynie, czy nasze ujęcie „budzika" — wywodzące się **wyłącznie z
własnej akcji gracza** i bez jakiegokolwiek monitoringu — cokolwiek w tej ocenie
zmienia, czy też nie.

**Pytanie, o które naprawdę pytamy.** Czy **sam akt** — oznaczenie konkretnego
rekordu o konkretnym czasie z listy zdarzeń jako „budzik na tę godzinę", co
przekłada się na zarejestrowanie tego czasu jako opóźnionego powiadomienia push —
**mieści się w przyjętej przez Was strategii fair-play, czy już ją przekracza?**
Niezależnie od tego, że jest to budzik i że dotyczy własnej floty. Innymi słowy:
czy taka funkcja mogłaby uzyskać Waszą zgodę na realizację, a jeśli tak — pod
jakimi warunkami lub w jak zawężonym zakresie?

**Uczciwe zamknięcie.** Zdajemy sobie sprawę, że to budzi wątpliwości, i **nie
chcemy rozstrzygać tego samodzielnie ani zakładać korzystnej interpretacji**.
Jeśli uznacie, że funkcja jest niedopuszczalna, po prostu jej nie zrealizujemy w
formie powiadomień poza grę — ograniczymy się wyłącznie do sygnalizacji w
aktywnej karcie gry. Z góry dziękujemy za opinię.
