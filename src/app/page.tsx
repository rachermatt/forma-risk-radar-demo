import { Suspense } from "react";
import { connection } from "next/server";
import { DashboardApp } from "@/components/dashboard-app";
import { getDemoDataset } from "@/lib/demo/generator";
import Loading from "./loading";

export default async function Home() {
  // Nonce-based CSP requires per-request rendering so Next can attach the
  // request nonce to its framework bootstrap scripts.
  await connection();
  // This standalone edition is always synthetic, regardless of DATA_MODE.
  const data = getDemoDataset();
  return (
    <Suspense fallback={<Loading />}>
      <DashboardApp data={data} />
    </Suspense>
  );
}
