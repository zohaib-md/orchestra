<script setup lang="ts">
import { ref } from "vue";
import Overview from "./components/Overview.vue";
import Threads from "./components/Threads.vue";
import Tickets from "./components/Tickets.vue";
import Workers from "./components/Workers.vue";
import Timeline from "./components/Timeline.vue";
import Failures from "./components/Failures.vue";
import Llm from "./components/Llm.vue";

type View = "overview" | "threads" | "tickets" | "workers" | "timeline" | "failures" | "llm";
const view = ref<View>("overview");

const tabs: Array<{ id: View; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "threads", label: "Threads" },
  { id: "tickets", label: "Tickets" },
  { id: "workers", label: "Workers" },
  { id: "timeline", label: "Timeline" },
  { id: "failures", label: "Failures" },
  { id: "llm", label: "LLM" },
];
</script>

<template>
  <header>
    <h1>Orchestra</h1>
    <nav>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: view === tab.id }"
        @click="view = tab.id"
      >
        {{ tab.label }}
      </button>
    </nav>
  </header>
  <main>
    <Overview v-if="view === 'overview'" />
    <Threads v-else-if="view === 'threads'" />
    <Tickets v-else-if="view === 'tickets'" />
    <Workers v-else-if="view === 'workers'" />
    <Timeline v-else-if="view === 'timeline'" />
    <Failures v-else-if="view === 'failures'" />
    <Llm v-else />
  </main>
</template>
