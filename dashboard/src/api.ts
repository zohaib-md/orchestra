import { onMounted, ref } from "vue";

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`API ${res.status} for ${path}`);
  return (await res.json()) as T;
}

export function useGet<T>(path: string) {
  const data = ref<T | null>(null);
  const error = ref<string | null>(null);
  const loading = ref(false);
  async function load(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      data.value = await get<T>(path);
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      loading.value = false;
    }
  }
  onMounted(load);
  return { data, error, loading, load };
}

export function fmtTime(t: number | null): string {
  return t === null || t === 0 ? "—" : new Date(t).toLocaleTimeString();
}

export function fmtDuration(start: number | null, end: number | null): string {
  if (start === null) return "—";
  const ms = (end ?? Date.now()) - start;
  return `${(ms / 1000).toFixed(1)}s`;
}
