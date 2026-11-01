<script setup lang="ts">
import { ref } from "vue";
import { useGet, fmtTime } from "../api";

interface Thread {
  id: string;
  sourceId: string;
  label: string | null;
  triggerCount: number;
}

interface Trigger {
  id: string;
  actor: string;
  kind: string;
  externalId: string;
  createdAt: number;
  payload: string;
}

const { data, error, loading, load } = useGet<Thread[]>("/api/threads");
const selected = ref<string | null>(null);
const detail = ref<{ thread: Thread; triggers: Trigger[] } | null>(null);

async function select(id: string): Promise<void> {
  selected.value = id;
  const res = await fetch(`/api/threads/${encodeURIComponent(id)}`);
  detail.value = await res.json();
}
</script>

<template>
  <div>
    <h2>Threads</h2>
    <button class="refresh" @click="load">Refresh</button>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-if="loading">Loading…</div>
    <div v-else-if="data" class="panel">
      <table>
        <thead>
          <tr><th>Thread</th><th>Source</th><th>Triggers</th></tr>
        </thead>
        <tbody>
          <tr v-for="t in data" :key="t.id">
            <td><button class="link" @click="select(t.id)">{{ t.label ?? t.id }}</button></td>
            <td class="mono muted">{{ t.sourceId }}</td>
            <td>{{ t.triggerCount }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="detail" class="panel">
      <h2>{{ detail.thread.label ?? detail.thread.id }}</h2>
      <table>
        <thead>
          <tr><th>Time</th><th>Actor</th><th>Kind</th><th>External</th><th>Payload</th></tr>
        </thead>
        <tbody>
          <tr v-for="tr in detail.triggers" :key="tr.id">
            <td class="muted">{{ fmtTime(tr.createdAt) }}</td>
            <td>{{ tr.actor }}</td>
            <td class="mono">{{ tr.kind }}</td>
            <td class="mono muted">{{ tr.externalId }}</td>
            <td class="mono muted">{{ tr.payload }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
