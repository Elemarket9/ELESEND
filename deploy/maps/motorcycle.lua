-- Motorcycle routing for Ghana. Starts from OSRM's car rules, then applies motorcycle access,
-- lets bikes use tracks and paths cars cannot, and reduces waiting at junctions.
-- One-way streets stay one-way. Speeds are starting values until rider trips can tune them.
package.path = '/opt/?.lua;' .. package.path
local car = dofile('/opt/car.lua')

local function setup()
  local profile = car.setup()
  profile.properties.weight_name = 'routability'
  profile.properties.u_turn_penalty = 10
  profile.properties.traffic_light_penalty = 1
  profile.default_speed = 25
  profile.vehicle_height = 1.5
  profile.vehicle_width = 1.0
  profile.vehicle_length = 2.2
  profile.vehicle_weight = 400
  profile.access_tag_hierarchy = Sequence { 'motorcycle', 'motor_vehicle', 'vehicle', 'access' }
  profile.restrictions = Sequence { 'motorcycle', 'motor_vehicle', 'vehicle' }
  profile.barrier_whitelist['bollard'] = true
  profile.barrier_whitelist['cycle_barrier'] = true
  local road = profile.speeds.highway
  road.residential = 30
  road.living_street = 15
  road.service = 20
  road.unclassified = 35
  road.track = 18
  road.path = 12
  return profile
end

return {
  setup = setup,
  process_way = car.process_way,
  process_node = car.process_node,
  process_turn = car.process_turn
}
