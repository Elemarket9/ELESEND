-- Migration 024: Restaurant Marketplace, Menus, Modifiers, Food Orders and Preparation-Aware Dispatch
-- Enforces independent food-sales commission (default 10% / 1000 bps, max 30% / 3000 bps)
-- decoupled from the delivery platform commission (13%).

CREATE TABLE IF NOT EXISTS restaurants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id),
  name text NOT NULL CHECK(length(trim(name)) >= 2),
  phone text NOT NULL CHECK(phone ~ '^\+233[25][0-9]{8}$'),
  address text NOT NULL,
  latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
  operating_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_open boolean NOT NULL DEFAULT true,
  is_paused boolean NOT NULL DEFAULT false,
  prep_time_minutes integer NOT NULL DEFAULT 20 CHECK(prep_time_minutes BETWEEN 5 AND 120),
  delivery_radius_m integer NOT NULL DEFAULT 10000 CHECK(delivery_radius_m BETWEEN 500 AND 50000),
  food_commission_bps integer NOT NULL DEFAULT 1000 CHECK(food_commission_bps BETWEEN 0 AND 3000),
  status text NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved','suspended','rejected')),
  image_url text,
  cuisine text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS restaurants_owner ON restaurants(owner_id);
CREATE INDEX IF NOT EXISTS restaurants_location ON restaurants(latitude, longitude);
CREATE INDEX IF NOT EXISTS restaurants_status_open ON restaurants(status, is_open, is_paused);

CREATE TABLE IF NOT EXISTS menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) >= 1),
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_categories_restaurant ON menu_categories(restaurant_id, display_order);

CREATE TABLE IF NOT EXISTS menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id uuid REFERENCES menu_categories(id) ON DELETE SET NULL,
  name text NOT NULL CHECK(length(trim(name)) >= 1),
  description text,
  price_minor integer NOT NULL CHECK(price_minor >= 0),
  image_url text,
  is_available boolean NOT NULL DEFAULT true,
  prep_time_minutes integer DEFAULT 15 CHECK(prep_time_minutes IS NULL OR prep_time_minutes BETWEEN 1 AND 180),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_items_restaurant ON menu_items(restaurant_id, category_id, is_available);

CREATE TABLE IF NOT EXISTS menu_item_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id uuid NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) >= 1),
  min_selections integer NOT NULL DEFAULT 0 CHECK(min_selections >= 0),
  max_selections integer NOT NULL DEFAULT 1 CHECK(max_selections >= min_selections),
  is_required boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_item_modifiers_item ON menu_item_modifiers(item_id);

CREATE TABLE IF NOT EXISTS menu_modifier_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  modifier_id uuid NOT NULL REFERENCES menu_item_modifiers(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(trim(name)) >= 1),
  price_minor integer NOT NULL DEFAULT 0 CHECK(price_minor >= 0),
  is_available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS menu_modifier_options_modifier ON menu_modifier_options(modifier_id);

CREATE TABLE IF NOT EXISTS food_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES users(id),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  shipment_id uuid REFERENCES shipments(id),
  state text NOT NULL DEFAULT 'SUBMITTED' CHECK(state IN ('SUBMITTED','ACCEPTED','PREPARING','READY_FOR_PICKUP','IN_TRANSIT','DELIVERED','REJECTED','CANCELLED')),
  subtotal_minor integer NOT NULL CHECK(subtotal_minor >= 0),
  food_commission_bps integer NOT NULL CHECK(food_commission_bps BETWEEN 0 AND 3000),
  food_commission_minor integer NOT NULL CHECK(food_commission_minor >= 0),
  delivery_fee_minor integer NOT NULL DEFAULT 0 CHECK(delivery_fee_minor >= 0),
  total_minor integer NOT NULL CHECK(total_minor >= 0),
  payment_method text NOT NULL DEFAULT 'CASH' CHECK(payment_method IN ('CASH','MOMO','CARD','QR')),
  payment_status text NOT NULL DEFAULT 'PENDING' CHECK(payment_status IN ('PENDING','PAID','FAILED','REFUNDED')),
  estimated_prep_minutes integer NOT NULL DEFAULT 20 CHECK(estimated_prep_minutes BETWEEN 1 AND 240),
  accepted_at timestamptz,
  ready_at timestamptz,
  completed_at timestamptz,
  delivery_address text NOT NULL,
  delivery_latitude double precision NOT NULL CHECK(delivery_latitude BETWEEN -90 AND 90),
  delivery_longitude double precision NOT NULL CHECK(delivery_longitude BETWEEN -180 AND 180),
  customer_phone text NOT NULL,
  special_instructions text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS food_orders_restaurant ON food_orders(restaurant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS food_orders_customer ON food_orders(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS food_orders_ready_at ON food_orders(state, ready_at) WHERE state IN ('ACCEPTED','PREPARING');

CREATE TABLE IF NOT EXISTS food_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES food_orders(id) ON DELETE CASCADE,
  item_id uuid NOT NULL REFERENCES menu_items(id),
  name text NOT NULL,
  quantity integer NOT NULL CHECK(quantity > 0),
  unit_price_minor integer NOT NULL CHECK(unit_price_minor >= 0),
  total_price_minor integer NOT NULL CHECK(total_price_minor >= 0),
  options_json jsonb NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS food_order_items_order ON food_order_items(order_id);

CREATE TABLE IF NOT EXISTS restaurant_settlements (
  order_id uuid PRIMARY KEY REFERENCES food_orders(id),
  restaurant_id uuid NOT NULL REFERENCES restaurants(id),
  gross_sales_minor integer NOT NULL CHECK(gross_sales_minor >= 0),
  commission_bps integer NOT NULL CHECK(commission_bps BETWEEN 0 AND 3000),
  commission_minor integer NOT NULL CHECK(commission_minor >= 0),
  net_payable_minor integer NOT NULL CHECK(net_payable_minor >= 0),
  status text NOT NULL DEFAULT 'accrued' CHECK(status IN ('accrued','settled','withheld')),
  settled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(gross_sales_minor = commission_minor + net_payable_minor)
);

CREATE INDEX IF NOT EXISTS restaurant_settlements_restaurant ON restaurant_settlements(restaurant_id, status);
