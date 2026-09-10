import { useState } from "react";
import { useAddressMutation } from "@/hooks/useOrders";
import type { OrderDetail } from "@/types/orders";

export function ShippingAddress({ order, onRefetch }: { order: OrderDetail; onRefetch: () => void }) {
  const [editing, setEditing] = useState(false);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const mutation = useAddressMutation();

  const startEdit = () => {
    setFields({
      shipping_name: order.shipping_name || "",
      shipping_postal_code: order.shipping_postal_code || "",
      shipping_state: order.shipping_state || "",
      shipping_city: order.shipping_city || "",
      shipping_address_1: order.shipping_address_1 || "",
      shipping_address_2: order.shipping_address_2 || "",
      shipping_phone_number: order.shipping_phone_number || "",
    });
    setError("");
    setEditing(true);
  };

  const save = async () => {
    setError("");
    try {
      await mutation.mutateAsync({ orderId: order.portal_target_id || order.order_id, ...fields });
      setEditing(false);
      onRefetch();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      setError(msg);
    }
  };

  const addressLine = [order.shipping_state, order.shipping_city, order.shipping_address_1, order.shipping_address_2]
    .filter(Boolean)
    .join(" ");

  return (
    <section className="mb-5">
      <h3 className="text-xs uppercase text-gray-400 mb-2 tracking-wider">
        Shipping
        <button onClick={startEdit} className="float-right bg-white border border-gray-300 px-2 py-0.5 rounded text-xs text-[#1565c0] hover:bg-gray-100 font-normal">
          Edit Address
        </button>
      </h3>

      {editing ? (
        <div>
          {Object.entries({
            shipping_name: "Name",
            shipping_postal_code: "Postal",
            shipping_state: "State",
            shipping_city: "City",
            shipping_address_1: "Address 1",
            shipping_address_2: "Address 2",
            shipping_phone_number: "Phone",
          }).map(([key, label]) => (
            <div key={key} className="flex items-center py-0.5">
              <span className="w-[110px] text-xs text-gray-500 flex-shrink-0">{label}</span>
              <input
                value={fields[key] || ""}
                onChange={(e) => setFields({ ...fields, [key]: e.target.value })}
                className="flex-1 px-2 py-1 border border-gray-300 rounded text-xs focus:outline-none focus:border-[#1565c0]"
              />
            </div>
          ))}
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
          <Field label="Name" value={order.shipping_name || "—"} />
          <Field label="Postal" value={order.shipping_postal_code || "—"} />
          <Field label="Address" value={addressLine || "—"} />
          <Field label="Phone" value={order.shipping_phone_number || "—"} />
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
