import { useQuery } from "@tanstack/react-query";
import { fetchTraceCredits } from "../lib/settings-api.js";

export function useTraceCredits() {
  const query = useQuery({
    queryKey: ["trace-credits"],
    queryFn: fetchTraceCredits,
  });

  return {
    credits: query.data || null,
    query,
  };
}
