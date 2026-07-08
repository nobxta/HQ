export function ChartTooltip({ active, payload, label, showSuccessRate = false }: any) {
  if (active && payload && payload.length) {
    // If showSuccessRate is true and we have both sent and failed, compute it
    let successRateStr = "";
    if (showSuccessRate) {
      const sentItem = payload.find((p: any) => p.dataKey === "sent");
      const failedItem = payload.find((p: any) => p.dataKey === "failed");
      const sent = sentItem ? Number(sentItem.value) : 0;
      const failed = failedItem ? Number(failedItem.value) : 0;
      const total = sent + failed;
      if (total > 0) {
        successRateStr = `${Math.round((sent / total) * 100)}%`;
      }
    }

    return (
      <div className="bg-[#111827] border border-[#293244] rounded-[10px] p-2.5 min-w-[140px] shadow-lg">
        <p className="text-[#98A2B3] text-[11px] mb-2 font-medium">{label}</p>
        {payload.map((entry: any, index: number) => (
          <div key={index} className="flex items-center gap-2 py-0.5">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: entry.color }} />
            <span className="text-[12px] text-[#98A2B3] flex-1">{entry.name}</span>
            <span className="text-[12px] font-semibold text-[#F4F7FB]">{entry.value}</span>
          </div>
        ))}
        {successRateStr && (
          <div className="flex items-center gap-2 py-0.5 mt-1 pt-1 border-t border-[#293244]">
            <span className="w-1.5 h-1.5 rounded-full bg-[#22C55E]" />
            <span className="text-[12px] text-[#98A2B3] flex-1">Success</span>
            <span className="text-[12px] font-semibold text-[#F4F7FB]">{successRateStr}</span>
          </div>
        )}
      </div>
    );
  }
  return null;
}
