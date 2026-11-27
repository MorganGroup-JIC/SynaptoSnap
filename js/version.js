/* SynaptoSnap — app version, date-based: YYYY.MM.DD, with .1, .2 … for further releases the same day.
   Bump it when releasing, and tag that commit "v" + APP_VERSION (e.g. v2026.11.26).
   The tracing engine has its own version (VERSION in js/tracing.js, e.g. 2026-11-24f). It is bumped only when
   tracing results change, is stored with every trace, and makes the app warn about traces from an older engine. */
const APP_VERSION = '2026.11.27';
