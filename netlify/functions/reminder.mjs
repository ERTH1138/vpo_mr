import { getStore } from "@netlify/blobs";
import { runReminders } from "./api.mjs";

// Óránként lefutó ütemezett függvény: 24 órával a kezdés előtt emlékeztetőt küld az ügyfélportálos foglalásokról.
export default async () => {
  const store = getStore({ name: "rogzito", consistency: "strong" });
  const r = await runReminders(store, Date.now());
  console.log("reminders", JSON.stringify(r));
};

export const config = { schedule: "@hourly" };
