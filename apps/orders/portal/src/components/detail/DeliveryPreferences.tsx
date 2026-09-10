import { useState } from "react";
import { useDeliveryPrefsMutation } from "@/hooks/useOrders";
import type { OrderDetail } from "@/types/orders";
import { DELIVERY_TIME_SLOTS } from "@/lib/constants";

export function DeliveryPreferences({ order, onRefetch }: { order: OrderDetail; onRefetch: () => void }) {
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(order.requested_delivery_date || "");
  const [time, setTime] = useState(order.requested_delivery_time || "");
  const [error, setError] = useState("");
  const mutation = useDeliveryPrefsMutation();

  const startEdit = () => {
    setDate(order.requested_delivery_date || "");
    setTime(order.requested_delivery_time || "");
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setError("");
    try {
      await mutation.mutateAsync({
        orderId: order.portal_target_id || order.order_id,
        requested_delivery_date: date,
        requested_delivery_time: time,
      });
      setEditing(false);
      onRefetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    }
  };

  return (
    <section className="mb-5">
      {editing ? (
        <div className="mt-2">
          <div className="flex items-center py-1">
            <span className="w-[110px] text-xs text-gray-500 flex-shrink-0">Delivery Date</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
            />
          </div>
          <div className="flex items-center py-1">
            <span className="w-[110px] text-xs text-gray-500 flex-shrink-0">Delivery Time</span>
            <select
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs bg-white focus:outline-none focus:border-[#1565c0]"
            >
              <option value="">— Clear —</option>
              {DELIVERY_TIME_SLOTS.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end mt-2">
            <button onClick={() => setEditing(false)} className="px-3 py-1 bg-white border border-gray-300 rounded text-xs text-gray-500">
              Cancel
            </button>
            <button onClick={save} disabled={mutation.isPending} className="px-3 py-1 bg-[#1565c0] text-white border-none rounded text-xs">
              Save
            </button>
          </div>
          {error && (
            <div className="mt-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div>
          <Field label="Delivery Date" value={order.requested_delivery_date || "—"} />
          <Field label="Delivery Time" value={order.requested_delivery_time || "—"} />
          <div className="flex justify-end mt-2">
            <button onClick={startEdit} className="bg-white border border-gray-300 px-2 py-0.5 rounded text-xs text-[#1565c0] hover:bg-gray-100">
              Edit Delivery Date &amp; Time
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1 text-sm border-b border-dotted border-gray-200">
      <span className="text-gray-500">{label}</span>
      <span className="font-medium text-right">{value}</span>
    </div>
  );
}
