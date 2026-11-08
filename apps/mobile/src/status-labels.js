// One place that turns the states stored by the API into words people read.
const CUSTOMER = {
  CREATED: 'Order placed',
  AWAITING_PAYMENT: 'Waiting for payment',
  AWAITING_ASSIGNMENT: 'Finding a courier',
  RIDER_ASSIGNED: 'Courier assigned',
  PICKUP_VERIFIED: 'Picked up',
  IN_TRANSIT: 'On the way',
  AWAITING_DELIVERY_OTP: 'Handover in progress',
  COMPLETED: 'Delivered',
  DELIVERED: 'Delivered',
  FAILED: 'Delivery failed',
  RETURN_REQUESTED: 'Being returned',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
  SUBMITTED: 'Sent to restaurant',
  ACCEPTED: 'Accepted by restaurant',
  PREPARING: 'Being prepared',
  READY_FOR_PICKUP: 'Ready for pickup',
  REJECTED: 'Declined by restaurant'
};

const RIDER = {
  ...CUSTOMER,
  AWAITING_ASSIGNMENT: 'Waiting for a rider',
  RIDER_ASSIGNED: 'Go to pickup',
  IN_TRANSIT: 'Delivering',
  AWAITING_DELIVERY_OTP: 'Confirm physical handover',
  RETURN_REQUESTED: 'Return to sender'
};

function readable(state) {
  const words = String(state || '').replace(/_/g, ' ').toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : '';
}

export const customerStatus = state => CUSTOMER[state] || readable(state);
export const riderStatus = state => RIDER[state] || readable(state);
export const paymentLabel = method => (method === 'CASH' ? 'Cash' : method === 'MOMO' ? 'Mobile Money' : method === 'CARD' ? 'Card' : readable(method));
