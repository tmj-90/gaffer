---
name: kubernetes-operator
description: Use when building a Kubernetes Operator — custom controllers that reconcile CRD state. Triggers on "build an operator", "CRD design", "reconcile loop", "controller-runtime", "kubebuilder", "operator-sdk", "custom resource", or "operator capability levels". NOT a generic k8s skill — specifically the Operator pattern.
stack: [kubernetes]
area: infra
---

# Build operators that reconcile correctly

An operator is a level-based control loop: each `Reconcile` reads the whole current state,
computes what should exist, converges one step, and records what it observed. Most operator
bugs are distributed-systems bugs — stale caches, conflicting writers, a paused leader —
not Kubernetes API bugs. Sources: the Kubernetes API conventions, the kubebuilder book's
"Good practices", and the controller-runtime FAQ.

## Invariants

- **Idempotent and level-based.** Reconcile must produce the same result however many
  times it runs and must not branch on "was this a create or an update event" — events are
  coalesced and dropped. Read all needed state, then write.
- **One controller per Kind.** Children map back to their root via `Owns(...)` /
  `handler.EnqueueRequestForOwner`; other Kinds via `EnqueueRequestsFromMapFunc`.
- **Spec is the user's, status is yours.** Enable the status subresource
  (`+kubebuilder:subresource:status`), write status only through it, and report
  `metav1.Condition`s (`Type`, `Status`, `Reason`, `Message`, `ObservedGeneration`) plus
  `status.observedGeneration`.
- **Assume the cache is stale.** Use deterministic child names so a duplicate create
  fails with `AlreadyExists` instead of creating two.
- **Writes are optimistic.** Every update carries a `resourceVersion`; a `Conflict` means
  someone else wrote — return the error and let the requeue re-read. Never retry by
  blindly re-applying your stale copy. Prefer `Patch` (merge-from) or server-side apply
  with a field owner for children.

## Procedure

1. **Read what exists.** `search_lore` for framework, CRD group/version conventions and
   RBAC policy. Match the existing toolchain (kubebuilder, operator-sdk, KOPF). Target OLM
   capability level 1 (basic install) first; promote only when lower levels are tested.
2. **Design the API.** Minimal `spec`; validation in the schema (kubebuilder markers,
   CEL `x-kubernetes-validations`) before reaching for a webhook; defaults via markers;
   `status` with conditions such as `Ready`/`Degraded`. Version the API (`v1alpha1`) and
   never repurpose a field.
3. **Implement Reconcile** in this order: get the object (not found → return nil);
   handle `DeletionTimestamp` (run cleanup, remove finalizer, return); ensure finalizer
   (only if you own resources outside the cluster or across namespaces — otherwise
   owner references + garbage collection suffice); converge each child with
   `controllerutil.SetControllerReference`; update status; return.
4. **Return values mean something.** Transient error → `return ctrl.Result{}, err`
   (rate-limited backoff). Waiting on something external → `RequeueAfter`. Invalid spec
   the user must fix → set a condition and return without error (or
   `reconcile.TerminalError`) so it does not hot-loop. Every external call takes the
   request `ctx` with a timeout. Do not hand work to a goroutine Reconcile never
   observes — its error is lost and nothing requeues; start long external work
   idempotently and poll it with `RequeueAfter`.
5. **Concurrency and leadership.** The workqueue never processes the same key
   concurrently, but different keys run in parallel under `MaxConcurrentReconciles` —
   state shared across keys (in-memory maps, external quotas) needs synchronisation.
   Enable leader election for >1 replica and keep the default "exit on lost lease". A
   leader paused past its lease (GC, SIGSTOP, node freeze) may resume and write before it
   notices: `resourceVersion` conflicts fence Kubernetes writes, but external side effects
   need idempotency keys or their own fencing. Live runs lost acknowledged writes to exactly
   this time-only lease pattern.
6. **Avoid self-triggered loops.** Use `predicate.GenerationChangedPredicate` on the
   primary resource when status updates should not re-trigger reconciliation; never
   write status fields that change every run (timestamps) without a real change.
7. **RBAC and manifests.** `+kubebuilder:rbac` markers with the narrowest verbs and
   resources; no wildcards; namespace-scoped `Role` unless cluster scope is required and
   documented. Regenerate (see Verification) and commit generated files; never hand-edit
   them.
8. **Verify** (below), evidence each acceptance criterion with the `record-evidence`
   skill, then stop.

## Verification

- Regenerate by running the Makefile's `generate` and `manifests` command lines directly
  with a `controller-gen` binary that already exists (`bin/controller-gen-<version>` or
  one on `PATH`), then `git diff --exit-code` on generated files — clean. Do not run
  `make generate manifests`: the scaffold's Makefile `go install`s controller-gen unless
  its exact versioned binary is present. With no binary, do not regenerate; say so in
  evidence.
- `go vet ./...`; `golangci-lint run` if configured.
- Tests with `envtest` (a real API server), not the fake client — only when its binaries
  are already present (`KUBEBUILDER_ASSETS` set or `bin/k8s/` populated); never run
  `setup-envtest` or a `make test` that fetches them. Tests assert resulting
  state rather than API-call sequences. Cover: create → children and `Ready` condition;
  spec update → children converge and `observedGeneration` advances; delete → finalizer
  cleanup runs and the object disappears; reconcile run twice → no extra writes;
  dependency failure → condition `False` with reason and a requeue; a conflicting update
  between read and write → no lost field.
- If the repo's tooling creates a local kind cluster, an e2e create/update/delete run
  against it. First check `kubectl config current-context` names that kind cluster;
  never run against a shared or production cluster from an ambient kubeconfig.

## Review checklist (concrete defects only)

- Reconcile branches on event type or assumes the previous call's outcome.
- Status written via the main resource, or spec mutated by the controller.
- Conflict handled by retry-with-stale-object; child created with a random name.
- Finalizer added without idempotent cleanup, or never removed on success.
- Terminal spec error returned as `err` (hot loop), or transient error swallowed.
- Wildcard RBAC, cluster scope without justification, leader election off with >1
  replica.
- Tests use only the fake client or assert call sequences.

## Capture lore

Framework choice, API group conventions, cluster version and RBAC policy are high-value
lore: call `suggest_lore` with `tags: [kubernetes, operator, crd]`.
