import { useEffect, useMemo, useSyncExternalStore } from "react";
import { supabase } from "./supabase";
import { LEGACY_REFERENCE_KEY, ReferencePointSync, emptyReferenceStore, parseReferenceStore } from "./referencePoints";
import type { ReferenceRemote } from "./referencePoints";

const storage = {
  getItem: (key: string) => window.localStorage.getItem(key),
  setItem: (key: string, value: string) => window.localStorage.setItem(key, value),
};

function accountRemote(userId: string): ReferenceRemote {
  return {
    async read() {
      const { data, error } = await supabase.from("reference_point_stores")
        .select("store,revision").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return data ? { store: parseReferenceStore(data.store), revision: data.revision as number } : null;
    },
    async write(store, revision) {
      const payload = { user_id: userId, store, revision: (revision ?? 0) + 1 };
      if (revision === null) {
        const { error } = await supabase.from("reference_point_stores").insert(payload);
        if (error?.code === "23505") return false;
        if (error) throw error;
        return true;
      }
      const { data, error } = await supabase.from("reference_point_stores")
        .update(payload).eq("user_id", userId).eq("revision", revision).select("revision");
      if (error) throw error;
      return data.length === 1;
    },
  };
}

export function useReferencePoints(userId: string | undefined) {
  const controller = useMemo(() => new ReferencePointSync(
    userId ? accountRemote(userId) : null,
    storage,
    userId ? `${LEGACY_REFERENCE_KEY}:account:${userId}` : LEGACY_REFERENCE_KEY,
  ), [userId]);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const legacy = (() => {
    try {
      return parseReferenceStore(JSON.parse(storage.getItem(LEGACY_REFERENCE_KEY) ?? "null"));
    } catch { return emptyReferenceStore(); }
  })();

  useEffect(() => {
    controller.start();
    const refresh = () => { void controller.sync(); };
    const visibleRefresh = () => { if (!document.hidden) refresh(); };
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", visibleRefresh);
    const timer = window.setInterval(visibleRefresh, 30_000);
    return () => {
      controller.stop();
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", visibleRefresh);
      window.clearInterval(timer);
    };
  }, [controller]);

  return {
    store: snapshot.store,
    setStore: controller.update,
    syncStatus: snapshot.status,
    syncError: snapshot.error,
    retrySync: controller.sync,
    importCount: userId && !snapshot.imported
      ? legacy.groups.reduce((sum, group) => sum + group.points.length, 0) : 0,
    importBrowserPoints: () => controller.import(legacy),
  };
}
