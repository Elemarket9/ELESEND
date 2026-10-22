import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {check} from './security.mjs';
import {haversine} from './dispatch-geometry.mjs';

const uuid = z.string().uuid();
const phoneSchema = z.string().trim().regex(/^(\+233|0)[25][0-9]{8}$/, 'Valid Ghana phone number required');

function normalizePhone(p) {
  const clean = p.replace(/\s+/g, '');
  if (clean.startsWith('0')) return '+233' + clean.slice(1);
  return clean;
}

const operatingHoursSchema = z.record(
  z.string(),
  z.object({
    open: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    close: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    closed: z.boolean().optional()
  })
).default({});

export function restaurantService(db) {
  check(db && typeof db.query === 'function', 500, 'Database instance required');

  async function createRestaurant(actor, input) {
    check(actor && ['business', 'admin'].includes(actor.kind), 403, 'Business or admin account required');
    const schema = z.object({
      name: z.string().trim().min(2).max(100),
      phone: phoneSchema,
      address: z.string().trim().min(3).max(255),
      latitude: z.number().finite().min(4.5).max(11.5),
      longitude: z.number().finite().min(-3.5).max(1.5),
      operatingHours: operatingHoursSchema.optional(),
      prepTimeMinutes: z.number().int().min(5).max(120).default(20),
      deliveryRadiusM: z.number().int().min(500).max(50000).default(10000),
      cuisine: z.string().trim().max(100).optional(),
      imageUrl: z.string().trim().url().optional()
    }).strict();

    const data = schema.parse(input);
    const id = randomUUID();
    const phone = normalizePhone(data.phone);
    const ownerId = actor.kind === 'admin' && input.ownerId ? uuid.parse(input.ownerId) : actor.id;
    const foodCommissionBps = actor.kind === 'admin' && Number.isInteger(input.foodCommissionBps)
      ? Math.min(10000, Math.max(0, input.foodCommissionBps))
      : 1000; // Default 10%

    const row = (await db.query(
      `INSERT INTO restaurants (
        id, owner_id, name, phone, address, latitude, longitude,
        operating_hours, prep_time_minutes, delivery_radius_m, food_commission_bps,
        status, image_url, cuisine
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'approved', $12, $13)
      RETURNING *`,
      [
        id, ownerId, data.name, phone, data.address, data.latitude, data.longitude,
        JSON.stringify(data.operatingHours || {}), data.prepTimeMinutes, data.deliveryRadiusM,
        foodCommissionBps, data.imageUrl || null, data.cuisine || null
      ]
    )).rows[0];

    return row;
  }

  async function getRestaurant(id) {
    uuid.parse(id);
    const r = (await db.query('SELECT * FROM restaurants WHERE id = $1', [id])).rows[0];
    check(r, 404, 'Restaurant not found');
    return r;
  }

  async function listRestaurants({ latitude = null, longitude = null, limit = 50, cuisine = null, search = null, ownerId = null } = {}) {
    const lim = Math.max(1, Math.min(100, Number(limit) || 50));
    let query = `SELECT * FROM restaurants`;
    const conditions = [];
    const params = [];

    if (ownerId) {
      params.push(ownerId);
      conditions.push(`owner_id = $${params.length}`);
    } else {
      conditions.push(`status = 'approved'`);
    }

    if (cuisine) {
      params.push(`%${cuisine.toLowerCase()}%`);
      conditions.push(`LOWER(cuisine) LIKE $${params.length}`);
    }

    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      conditions.push(`(LOWER(name) LIKE $${params.length} OR LOWER(address) LIKE $${params.length})`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY is_open DESC, is_paused ASC, created_at DESC LIMIT $${params.length + 1}`;
    params.push(lim);

    const rows = (await db.query(query, params)).rows;

    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return rows.map(r => {
        const distM = haversine({ latitude, longitude }, { latitude: r.latitude, longitude: r.longitude });
        return {
          ...r,
          distanceMeters: Math.round(distM),
          isDeliverable: distM <= r.delivery_radius_m
        };
      }).sort((a, b) => a.distanceMeters - b.distanceMeters);
    }

    return rows;
  }

  async function updateRestaurant(actor, id, updates) {
    uuid.parse(id);
    const existing = await getRestaurant(id);
    check(actor && (actor.kind === 'admin' || existing.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      name: z.string().trim().min(2).max(100).optional(),
      phone: phoneSchema.optional(),
      address: z.string().trim().min(3).max(255).optional(),
      latitude: z.number().finite().min(4.5).max(11.5).optional(),
      longitude: z.number().finite().min(-3.5).max(1.5).optional(),
      operatingHours: operatingHoursSchema.optional(),
      isOpen: z.boolean().optional(),
      isPaused: z.boolean().optional(),
      prepTimeMinutes: z.number().int().min(5).max(120).optional(),
      deliveryRadiusM: z.number().int().min(500).max(50000).optional(),
      cuisine: z.string().trim().max(100).optional(),
      imageUrl: z.string().trim().url().optional(),
      status: z.enum(['pending', 'approved', 'suspended', 'rejected']).optional(),
      foodCommissionBps: z.number().int().min(0).max(10000).optional()
    }).strict();

    const data = schema.parse(updates);

    if (data.status || data.foodCommissionBps !== undefined) {
      check(actor.kind === 'admin', 403, 'Only administrator can change status or food commission');
    }

    const setClauses = [];
    const values = [];

    if (data.name !== undefined) { values.push(data.name); setClauses.push(`name = $${values.length}`); }
    if (data.phone !== undefined) { values.push(normalizePhone(data.phone)); setClauses.push(`phone = $${values.length}`); }
    if (data.address !== undefined) { values.push(data.address); setClauses.push(`address = $${values.length}`); }
    if (data.latitude !== undefined) { values.push(data.latitude); setClauses.push(`latitude = $${values.length}`); }
    if (data.longitude !== undefined) { values.push(data.longitude); setClauses.push(`longitude = $${values.length}`); }
    if (data.operatingHours !== undefined) { values.push(JSON.stringify(data.operatingHours)); setClauses.push(`operating_hours = $${values.length}`); }
    if (data.isOpen !== undefined) { values.push(data.isOpen); setClauses.push(`is_open = $${values.length}`); }
    if (data.isPaused !== undefined) { values.push(data.isPaused); setClauses.push(`is_paused = $${values.length}`); }
    if (data.prepTimeMinutes !== undefined) { values.push(data.prepTimeMinutes); setClauses.push(`prep_time_minutes = $${values.length}`); }
    if (data.deliveryRadiusM !== undefined) { values.push(data.deliveryRadiusM); setClauses.push(`delivery_radius_m = $${values.length}`); }
    if (data.cuisine !== undefined) { values.push(data.cuisine); setClauses.push(`cuisine = $${values.length}`); }
    if (data.imageUrl !== undefined) { values.push(data.imageUrl); setClauses.push(`image_url = $${values.length}`); }
    if (data.status !== undefined) { values.push(data.status); setClauses.push(`status = $${values.length}`); }
    if (data.foodCommissionBps !== undefined) { values.push(data.foodCommissionBps); setClauses.push(`food_commission_bps = $${values.length}`); }

    if (setClauses.length === 0) return existing;

    values.push(id);
    const updated = (await db.query(
      `UPDATE restaurants SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    )).rows[0];

    return updated;
  }

  // --- Category Management ---
  async function createCategory(actor, restaurantId, input) {
    uuid.parse(restaurantId);
    const r = await getRestaurant(restaurantId);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      name: z.string().trim().min(1).max(100),
      displayOrder: z.number().int().min(0).default(0),
      isActive: z.boolean().default(true)
    }).strict();
    const data = schema.parse(input);

    const id = randomUUID();
    return (await db.query(
      `INSERT INTO menu_categories (id, restaurant_id, name, display_order, is_active)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, restaurantId, data.name, data.displayOrder, data.isActive]
    )).rows[0];
  }

  async function updateCategory(actor, categoryId, input) {
    uuid.parse(categoryId);
    const cat = (await db.query('SELECT * FROM menu_categories WHERE id = $1', [categoryId])).rows[0];
    check(cat, 404, 'Category not found');
    const r = await getRestaurant(cat.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      name: z.string().trim().min(1).max(100).optional(),
      displayOrder: z.number().int().min(0).optional(),
      isActive: z.boolean().optional()
    }).strict();
    const data = schema.parse(input);

    return (await db.query(
      `UPDATE menu_categories SET
        name = COALESCE($2, name),
        display_order = COALESCE($3, display_order),
        is_active = COALESCE($4, is_active)
       WHERE id = $1 RETURNING *`,
      [categoryId, data.name ?? null, data.displayOrder ?? null, data.isActive ?? null]
    )).rows[0];
  }

  async function deleteCategory(actor, categoryId) {
    uuid.parse(categoryId);
    const cat = (await db.query('SELECT * FROM menu_categories WHERE id = $1', [categoryId])).rows[0];
    check(cat, 404, 'Category not found');
    const r = await getRestaurant(cat.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');
    await db.query('DELETE FROM menu_categories WHERE id = $1', [categoryId]);
    return { ok: true };
  }

  // --- Menu Item Management ---
  async function createMenuItem(actor, restaurantId, input) {
    uuid.parse(restaurantId);
    const r = await getRestaurant(restaurantId);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      categoryId: z.string().uuid().optional().nullable(),
      name: z.string().trim().min(1).max(120),
      description: z.string().trim().max(500).optional().nullable(),
      priceMinor: z.number().int().min(0),
      imageUrl: z.string().trim().url().optional().nullable(),
      isAvailable: z.boolean().default(true),
      prepTimeMinutes: z.number().int().min(1).max(180).default(15)
    }).strict();
    const data = schema.parse(input);

    const id = randomUUID();
    return (await db.query(
      `INSERT INTO menu_items (
        id, restaurant_id, category_id, name, description, price_minor,
        image_url, is_available, prep_time_minutes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        id, restaurantId, data.categoryId || null, data.name, data.description || null,
        data.priceMinor, data.imageUrl || null, data.isAvailable, data.prepTimeMinutes
      ]
    )).rows[0];
  }

  async function updateMenuItem(actor, itemId, input) {
    uuid.parse(itemId);
    const item = (await db.query('SELECT * FROM menu_items WHERE id = $1', [itemId])).rows[0];
    check(item, 404, 'Menu item not found');
    const r = await getRestaurant(item.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      categoryId: z.string().uuid().optional().nullable(),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(500).optional().nullable(),
      priceMinor: z.number().int().min(0).optional(),
      imageUrl: z.string().trim().url().optional().nullable(),
      isAvailable: z.boolean().optional(),
      prepTimeMinutes: z.number().int().min(1).max(180).optional()
    }).strict();
    const data = schema.parse(input);

    const setClauses = [];
    const values = [];
    if (data.categoryId !== undefined) { values.push(data.categoryId); setClauses.push(`category_id = $${values.length}`); }
    if (data.name !== undefined) { values.push(data.name); setClauses.push(`name = $${values.length}`); }
    if (data.description !== undefined) { values.push(data.description); setClauses.push(`description = $${values.length}`); }
    if (data.priceMinor !== undefined) { values.push(data.priceMinor); setClauses.push(`price_minor = $${values.length}`); }
    if (data.imageUrl !== undefined) { values.push(data.imageUrl); setClauses.push(`image_url = $${values.length}`); }
    if (data.isAvailable !== undefined) { values.push(data.isAvailable); setClauses.push(`is_available = $${values.length}`); }
    if (data.prepTimeMinutes !== undefined) { values.push(data.prepTimeMinutes); setClauses.push(`prep_time_minutes = $${values.length}`); }

    if (setClauses.length === 0) return item;
    values.push(itemId);
    return (await db.query(
      `UPDATE menu_items SET ${setClauses.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    )).rows[0];
  }

  async function deleteMenuItem(actor, itemId) {
    uuid.parse(itemId);
    const item = (await db.query('SELECT * FROM menu_items WHERE id = $1', [itemId])).rows[0];
    check(item, 404, 'Menu item not found');
    const r = await getRestaurant(item.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');
    await db.query('DELETE FROM menu_items WHERE id = $1', [itemId]);
    return { ok: true };
  }

  // --- Modifiers & Options ---
  async function createModifier(actor, itemId, input) {
    uuid.parse(itemId);
    const item = (await db.query('SELECT * FROM menu_items WHERE id = $1', [itemId])).rows[0];
    check(item, 404, 'Menu item not found');
    const r = await getRestaurant(item.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      name: z.string().trim().min(1).max(100),
      minSelections: z.number().int().min(0).default(0),
      maxSelections: z.number().int().min(1).default(1),
      isRequired: z.boolean().default(false)
    }).strict();
    const data = schema.parse(input);
    check(data.maxSelections >= data.minSelections, 400, 'maxSelections must be >= minSelections');

    const id = randomUUID();
    return (await db.query(
      `INSERT INTO menu_item_modifiers (id, item_id, name, min_selections, max_selections, is_required)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [id, itemId, data.name, data.minSelections, data.maxSelections, data.isRequired]
    )).rows[0];
  }

  async function createModifierOption(actor, modifierId, input) {
    uuid.parse(modifierId);
    const mod = (await db.query('SELECT * FROM menu_item_modifiers WHERE id = $1', [modifierId])).rows[0];
    check(mod, 404, 'Modifier not found');
    const item = (await db.query('SELECT * FROM menu_items WHERE id = $1', [mod.item_id])).rows[0];
    const r = await getRestaurant(item.restaurant_id);
    check(actor && (actor.kind === 'admin' || r.owner_id === actor.id), 403, 'Permission denied');

    const schema = z.object({
      name: z.string().trim().min(1).max(100),
      priceMinor: z.number().int().min(0).default(0),
      isAvailable: z.boolean().default(true)
    }).strict();
    const data = schema.parse(input);

    const id = randomUUID();
    return (await db.query(
      `INSERT INTO menu_modifier_options (id, modifier_id, name, price_minor, is_available)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [id, modifierId, data.name, data.priceMinor, data.isAvailable]
    )).rows[0];
  }

  async function getMenu(restaurantId) {
    uuid.parse(restaurantId);
    const categories = (await db.query(
      'SELECT * FROM menu_categories WHERE restaurant_id = $1 ORDER BY display_order ASC',
      [restaurantId]
    )).rows;

    const items = (await db.query(
      'SELECT * FROM menu_items WHERE restaurant_id = $1 ORDER BY name ASC',
      [restaurantId]
    )).rows;

    const itemIds = items.map(i => i.id);
    let modifiers = [];
    let options = [];

    if (itemIds.length > 0) {
      modifiers = (await db.query(
        'SELECT * FROM menu_item_modifiers WHERE item_id = ANY($1::uuid[])',
        [itemIds]
      )).rows;

      const modIds = modifiers.map(m => m.id);
      if (modIds.length > 0) {
        options = (await db.query(
          'SELECT * FROM menu_modifier_options WHERE modifier_id = ANY($1::uuid[])',
          [modIds]
        )).rows;
      }
    }

    const optionsByMod = new Map();
    for (const opt of options) {
      if (!optionsByMod.has(opt.modifier_id)) optionsByMod.set(opt.modifier_id, []);
      optionsByMod.get(opt.modifier_id).push(opt);
    }

    const modsByItem = new Map();
    for (const mod of modifiers) {
      if (!modsByItem.has(mod.item_id)) modsByItem.set(mod.item_id, []);
      modsByItem.get(mod.item_id).push({
        ...mod,
        options: optionsByMod.get(mod.id) || []
      });
    }

    const itemsByCat = new Map();
    const uncategorized = [];

    for (const it of items) {
      const fullItem = {
        ...it,
        modifiers: modsByItem.get(it.id) || []
      };
      if (it.category_id) {
        if (!itemsByCat.has(it.category_id)) itemsByCat.set(it.category_id, []);
        itemsByCat.get(it.category_id).push(fullItem);
      } else {
        uncategorized.push(fullItem);
      }
    }

    return {
      categories: categories.map(cat => ({
        ...cat,
        items: itemsByCat.get(cat.id) || []
      })),
      uncategorized
    };
  }

  return {
    createRestaurant,
    getRestaurant,
    listRestaurants,
    updateRestaurant,
    createCategory,
    updateCategory,
    deleteCategory,
    createMenuItem,
    updateMenuItem,
    deleteMenuItem,
    createModifier,
    createModifierOption,
    getMenu
  };
}
