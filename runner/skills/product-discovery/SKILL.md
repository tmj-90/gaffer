---
name: product-discovery
description: Use when validating product opportunities, mapping assumptions, planning discovery sprints, or testing problem-solution fit before committing delivery resources. Triggers on "product discovery", "validate this idea", "opportunity solution tree", "discovery sprint", "assumption mapping", or "de-risk this bet".
stack: []
area: product
---

# De-risk product bets before building

Discovery answers one question before delivery spends money: *should we build this, and
will it work?* Marty Cagan (*Inspired*, *Transformed*) frames the answer as **four
risks** that must be tackled before building, not after:

- **Value.** Will customers buy it or choose to use it?
- **Usability.** Can users figure out how to use it?
- **Feasibility.** Can we build it with the time, skills and technology we have?
- **Business viability.** Does it work for the business: legal, sales, finance, brand?

Teresa Torres (*Continuous Discovery Habits*) supplies the working method. Hold weekly
touchpoints with customers, keep an **Opportunity Solution Tree** (OST), and run small
**assumption tests** rather than whole-idea experiments.

## Opportunity Solution Tree

```
Desired outcome     (one product metric the team can influence; baseline → target, by when)
 └─ Opportunity     (customer need / pain / desire, heard in interviews, NOT a feature)
     └─ Solution    (several candidates per opportunity: compare, don't fall in love)
         └─ Assumption test  (the cheapest test of the riskiest assumption)
```

- Use one outcome per tree. It is a *product* outcome such as activation or retention,
  not a business output like revenue.
- Opportunities come from customer stories: "tell me about the last time you…".
  Brainstorms and competitor lists do not produce opportunities.
- Pick a target opportunity by its size, market factors, company factors and customer
  factors. Then generate at least three solutions for it, so you compare rather than
  justify.

## Assumptions: map, then test the leap of faith

List each solution's assumptions under the four risks. Torres adds *ethical* risk: could
this harm users or others? Place every assumption on David Bland's assumption map
(*Testing Business Ideas*):

- **x axis: evidence**, from "have evidence" to "no evidence".
- **y axis: importance**, meaning "the bet fails if this is wrong".

Test the **important + no-evidence** quadrant first. Write each test as a falsifiable
hypothesis:

> We believe **[assumption]**. To verify, we will **[method]** and measure **[metric]**.
> We are right if **[threshold, set before running]**.

| Method (cheapest first) | Typical cost | Tests which risk |
|---|---|---|
| Existing data: analytics, support tickets, sales notes | hours | value, usability signals |
| Story-based customer interviews (5+) | days | problem exists, frequency, severity |
| One-question survey or in-product prompt | days | value, at scale |
| Fake door / landing-page smoke test | days | demand (value) |
| Prototype usability test (5 users) | days | usability |
| Wizard-of-Oz / concierge | 1–2 weeks | value + willingness to pay, with nothing built |
| Technical spike | days | feasibility |
| Stakeholder review (legal, sales, finance) | days | viability |
| A/B test on live traffic | weeks | behavioural impact, when traffic allows |

Interviews discover problems. Do not ask users whether they would use your solution,
because stated intent is weak evidence. Test solutions through behaviour: clicks, sign-ups,
completed tasks, payments.

## Steps

1. **Set the outcome.** Name one metric, its baseline, the target and the date. If no
   baseline exists, getting one is the first task.
2. **Gather evidence.** Collect interview notes, support tickets, analytics and lore
   (`search_lore`). Record every quote verbatim, with its source.
3. **Build the OST.** Diverge (many opportunities), cluster, then choose one target
   opportunity and write down why.
4. **Generate at least three solutions** for the target opportunity.
5. **Map assumptions** across value, usability, feasibility, viability and ethics. Place
   them on the importance × evidence map.
6. **Design tests** for the top 1–3 assumptions. Use the hypothesis template, and set the
   pass threshold before running anything. Choose the cheapest method that could
   *falsify* the assumption.
7. **Run the tests and record the results.** For each: hypothesis, method, sample, raw
   result, and what changed in the tree.
8. **Decide:** proceed, pivot or stop, with the evidence cited. On proceed, hand
   delivery the assumptions that remain untested, as explicit risks or acceptance
   criteria.
   An unattended agent cannot run interviews. It outputs the test plan and the evidence
   it could gather from data and lore, and marks the decision "pending evidence".

## Done when

- The outcome is specific, measurable and time-bound.
- The target opportunity is traced to customer evidence, not internal opinion.
- The riskiest assumptions are named and tested, with pass thresholds set in advance —
  or, unattended, each has a written test plan and the decision is marked "pending
  evidence".
- A proceed, pivot or stop decision is recorded with its evidence. Capture it via
  `suggest_lore` when that tool is available.

## Anti-patterns

- Validating the one idea you already like. Always compare solutions.
- Treating "users said they'd use it" as validation of value.
- Running a month-long build as the "experiment" when a fake door would answer the
  question in days.
- Setting the success threshold after seeing the data.
- Discovery done once, then forgotten. Keep the tree live as evidence arrives.
