---
name: mobile-ui
description: Use when a ticket builds or reworks UI in a React Native / Expo (or React + Capacitor) mobile app and it must feel like a real, store-credible native app — not a wrapped mobile website. Covers the native-feel bar, safe areas and edge-to-edge, gestures and back navigation, haptics, Dynamic Type and screen readers, store-readiness, and mobile performance. Invoke for "make this screen feel native", "build the mobile X screen", "this feels like a website", "would this get approved", or as the mobile pack for any app-UI change.
stack: [react-native, native, expo]
area: mobile
---

# Build store-credible native-feel mobile UI

A mobile screen is judged against the platform: Apple's Human Interface Guidelines on
iOS, Material 3 and Android's system behaviour on Android. It must respect insets and
system gestures, scale with the user's text size, speak to VoiceOver and TalkBack, stay
smooth, and clear the store reviewers' checklist. Build to that bar, and change only what
the ticket asks: a visual rework does not alter navigation routes, state, business or
game logic. A structural idea ("this should be a sheet") goes in the evidence as a
proposal, not into the diff.

## Steps

1. **Read the set-up.** Call `search_lore`; read `BRAND.md`/tokens (the `design-system`
   skill) and a sibling screen. Confirm the stack and versions: React Native (0.82+ runs
   only the New Architecture), Expo SDK, navigation library (React Navigation / Expo
   Router), animation (Reanimated), list (FlatList/FlashList), or Capacitor with a web
   UI. Extend the existing design language; do not re-pitch it.
2. **Insets and edge-to-edge.** Android apps targeting Android 15+ draw edge-to-edge,
   and targeting Android 16 removes the opt-out. Use `react-native-safe-area-context`
   (`SafeAreaProvider` + `useSafeAreaInsets` or its `SafeAreaView`; React Native's own
   `SafeAreaView` is deprecated) and apply insets per edge — backgrounds run under the
   bars, content and touch targets do not. Capacitor/web: `viewport-fit=cover` plus
   `env(safe-area-inset-*)`. Never hardcode status-bar or home-indicator heights.
3. **Navigation and back.** Use the navigator's native stack and platform transitions;
   iOS swipe-back works on every pushed screen; Android back (gesture, button, predictive
   back) goes through the navigator or `BackHandler`, closes sheets and dialogs first,
   and never exits the app from a nested screen. Unsaved-changes guards use the
   navigator's prevent-remove API, not a raw back-key listener.
4. **Platform idioms.** Bottom sheets or native modals for contextual tasks rather than
   centred web-style dialogs; native pickers, date pickers and share sheets; tab bars with
   3–5 destinations; pull-to-refresh only on refreshable lists. Follow the platform where
   the two differ (iOS back chevron and large titles; Android top app bar and system
   back) unless the brand explicitly unifies them. Close the usual web-hybrid tells:
   fade-only screen transitions (use the platform push or a shared-element transition),
   fonts flashing in after the splash (load them before hiding it), wrong scroll bounce,
   the default launch screen. On a visual rework, commit to the brand: a real type scale,
   branded chrome and one named hero detail per screen (taste items; they do not block
   review).
5. **Touch and feedback.** Targets at least 44×44 pt (iOS) / 48×48 dp (Android) — use
   `hitSlop` when the visual is smaller; pressed states on every touchable (`Pressable`
   with a style callback or Android ripple); haptics (`expo-haptics` or the repo's wrapper)
   on meaningful moments only — selection change, success, error — through one shared
   hook.
6. **Text size and accessibility.** Text scales with Dynamic Type / Android font scale up
   to at least 200%: no fixed-height text containers, layouts that wrap or scroll, and
   `maxFontSizeMultiplier` only on chrome that truly cannot grow. Every touchable has
   `accessibilityRole` (or `role`), an `accessibilityLabel` when it has no visible text,
   and `accessibilityState` for selected/disabled/checked; group related text with
   `accessible`; announce async results with `AccessibilityInfo.announceForAccessibility`.
   Respect Reduce Motion (`AccessibilityInfo.isReduceMotionEnabled` or Reanimated's
   `useReducedMotion`) and the system colour scheme (`useColorScheme`); check contrast in
   both schemes (4.5:1 text, 3:1 icons and borders).
7. **Keyboard.** Forms stay visible above the keyboard (`KeyboardAvoidingView` or the
   repo's keyboard library), `returnKeyType` moves to the next field, correct
   `keyboardType`/`textContentType`/`autoComplete` for email, codes and passwords, and
   tapping outside dismisses the keyboard where expected.
8. **Performance.** Animations on the UI thread (Reanimated worklets or
   `useNativeDriver: true`) using transforms and opacity; long lists virtualised with
   stable `keyExtractor` and memoised rows (FlashList where the repo uses it); images
   sized to their box and cached; no heavy work in render or on the JS thread during
   gestures. Frame-rate claims need a release build on a mid-range Android device or
   emulator — dev builds are not representative; without one, list it as unverified in
   the evidence rather than claiming smoothness.
9. **Store readiness** (flag, do not guess, anything that needs a human decision):
   purpose strings for every permission requested (iOS `NS…UsageDescription`, requested
   in context, not on launch); iOS privacy manifest and Play Data safety entries kept in
   step with new data collection; a real launch screen and app icon; no placeholder text
   or broken links; in-app account deletion when the app creates accounts (App Review
   5.1.1(v)); enough native functionality that the app is not a repackaged website
   (App Review 4.2).
10. **Verify and evidence.** Run type-check, lint and tests (React Native Testing Library:
    query by role and label). For each AC, a test or an E2E flow (Maestro or Detox if the
    repo has one, run only if a simulator or emulator is already available) that
    exercises its behaviour. Where one is, screenshot small and large phone, largest text
    size, dark mode and Android gesture back (into the repo's git-ignored test output;
    never committed unless an AC asks); you cannot drive VoiceOver/TalkBack, so
    assert roles, labels and states in tests and name any unchecked item in the evidence.
    A failing existing logic test means you changed behaviour — undo
    that change; never edit the test to pass. Record per-AC evidence with the
    `record-evidence` skill, then stop.

## Review checklist

A reviewer blocks on an item only when it breaks an AC, leaves an AC untested, or is a
correctness, security or WCAG A/AA defect; taste and polish items are `(optional)` notes.

- Nothing under the notch, status bar or home indicator; no hardcoded bar heights.
- Swipe-back and Android back behave natively; sheets close before screens pop.
- Targets ≥ 44 pt / 48 dp; pressed states present; haptics sparing and consistent.
- Text scales to 200% without clipping; every control has role, label and state.
- Reduce Motion and dark mode respected; contrast holds in both schemes.
- Tokens only; no raw hex or magic numbers in components.
- UI-thread animations; virtualised lists; no jank on a release build.
- Routes, state and logic unchanged unless the ticket asked; structural ideas raised as
  proposals.
- Permission strings, privacy disclosures and account deletion accounted for.

## Anti-patterns

- A web layout in a WebView with hover states, tiny links and centred modals.
- `Dimensions`-based status-bar maths; `SafeAreaView` wrapping the whole app blindly.
- `allowFontScaling={false}` app-wide; icon-only buttons with no label.
- Haptics on every tap; permission prompts on first launch with no context.

## Capture lore

This skill is one of the places durable, reusable knowledge naturally surfaces:
**A mobile convention this repo enforces — the design system/tokens, brand voice, a native-feel pattern, a store-submission requirement, or a "never touch" gameplay/logic boundary.** That kind of fact is *lore*. Capture it via the **lore-capture
protocol in your brief** (`CLAUDE.factory.md`, step 11 "Memory contribution"):
call the Memory MCP `suggest_lore` once at the close of your work — reusable
conventions, gotchas, decisions, and boundaries only, never per-ticket trivia.
