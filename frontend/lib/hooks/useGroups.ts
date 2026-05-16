import useSWR from "swr";
import api from "../api";
import type { GroupFile } from "../types";

const fetcher = (url: string) => api.get(url).then((r) => r.data);

export function useGroups() {
  return useSWR<{ groups: GroupFile[]; total: number }>("/api/groups", fetcher, { refreshInterval: 15000 });
}

export function useGroupFile(filename: string) {
  return useSWR<GroupFile>(
    filename ? `/api/groups/${encodeURIComponent(filename)}` : null,
    fetcher
  );
}
