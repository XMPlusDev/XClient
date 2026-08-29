<script setup lang="ts">
interface LookupResult {
  ip: string
  ipNumber: string
  ipVersion: number
  countryCode?: string | null
  countryName?: string | null
  region?: string | null
  city?: string | null
  latitude?: number | null
  longitude?: number | null
}

const query = ref('')
const result = ref<LookupResult | null>(null)
const error = ref<string | null>(null)
const pending = ref(false)

async function lookup(ip?: string) {
  pending.value = true
  error.value = null
  try {
    const path = ip ? `/api/ip?ip=${encodeURIComponent(ip)}` : '/api/me'
    result.value = await $fetch<LookupResult>(path)
  } catch (e: unknown) {
    const err = e as { data?: { message?: string }; message?: string }
    result.value = null
    error.value = err.data?.message ?? err.message ?? 'Lookup failed'
  } finally {
    pending.value = false
  }
}

onMounted(() => lookup())

const rows = computed(() => {
  const r = result.value
  if (!r) return []
  return [
    ['IP', r.ip],
    ['Version', `IPv${r.ipVersion}`],
    ['Number', r.ipNumber],
    ['Country', r.countryName ? `${r.countryName} (${r.countryCode})` : '—'],
    ['Region', r.region ?? '—'],
    ['City', r.city ?? '—'],
    ['Coordinates', r.latitude != null ? `${r.latitude}, ${r.longitude}` : '—'],
  ] as const
})
</script>

<template>
  <main>
    <h1>IP Geolocation</h1>

    <form @submit.prevent="lookup(query || undefined)">
      <input v-model="query" placeholder="8.8.8.8 or 2001:4860:4860::8888" spellcheck="false" />
      <button type="submit" :disabled="pending">{{ pending ? '…' : 'Look up' }}</button>
      <button type="button" class="ghost" :disabled="pending" @click="query = ''; lookup()">My IP</button>
    </form>

    <p v-if="error" class="error">{{ error }}</p>

    <table v-else-if="result">
      <tbody>
        <tr v-for="[label, value] in rows" :key="label">
          <th>{{ label }}</th>
          <td>{{ value }}</td>
        </tr>
      </tbody>
    </table>

    <!--<section class="api">
      <h2>API</h2>
      <ul>
        <li><code>GET /api/ip/8.8.8.8</code></li>
        <li><code>GET /api/ip?ip=8.8.8.8&amp;fields=countryCode,city</code></li>
        <li><code>GET /api/me</code></li>
        <li><code>POST /api/batch</code> — <code>{ "ips": ["8.8.8.8"] }</code></li>
        <li><code>GET /api/health</code></li>
      </ul>
    </section>-->
  </main>
</template>

<style>
:root {
  color-scheme: light dark;
  --fg: #16181d;
  --muted: #6b7280;
  --line: #e4e6eb;
  --bg: #fbfbfc;
  --accent: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e8eaed;
    --muted: #9aa1ab;
    --line: #2a2e37;
    --bg: #14161a;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif;
}
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
h1 { font-size: 1.5rem; margin: 0 0 0.25rem; letter-spacing: -0.01em; }
.sub { color: var(--muted); margin: 0 0 1.75rem; }
form { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
input {
  flex: 1 1 18rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
button {
  padding: 0.6rem 1rem;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font: inherit;
  cursor: pointer;
}
button.ghost { background: transparent; color: var(--fg); border-color: var(--line); }
button:disabled { opacity: 0.55; cursor: default; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 0.6rem 0; border-bottom: 1px solid var(--line); vertical-align: top; }
th { width: 9.5rem; color: var(--muted); font-weight: 500; }
td { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.error { color: #dc2626; }
.api { margin-top: 2.5rem; }
.api h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.api ul { list-style: none; padding: 0; margin: 0; }
.api li { padding: 0.3rem 0; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85em; }
</style>
