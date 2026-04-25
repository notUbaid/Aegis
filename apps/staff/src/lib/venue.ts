// Bundled venue config for the demo dashboard. Sourced from
// config/venues/taj-ahmedabad.json with the design's RSP-meera responder
// added so the staff app surface has the seeded crowd-control persona.

export interface VenueZone {
  zone_id: string;
  name: string;
  type: string;
  floor: number;
  capacity: number;
  exit_count: number;
  accessible: boolean;
  camera_ids: string[];
  sensor_ids: string[];
}

export interface VenueCamera {
  camera_id: string;
  zone_id: string;
  model: string;
  active: boolean;
}

export interface VenueResponder {
  responder_id: string;
  display_name: string;
  role: string;
  skills: string[];
  languages: string[];
  on_shift: boolean;
  credential_valid: boolean;
  distance_m: number;
  workload: number;
}

export interface NearbyService {
  name: string;
  phone: string;
  distance_km: number;
}

export interface Venue {
  venue_id: string;
  name: string;
  address: string;
  geo: { lat: number; lng: number };
  timezone: string;
  size_sqm: number;
  max_occupancy: number;
  languages: string[];
  zones: VenueZone[];
  cameras: VenueCamera[];
  responders: VenueResponder[];
  nearby_services: {
    ambulance: NearbyService[];
    fire: NearbyService[];
    hospitals: { name: string; distance_km: number; level: number }[];
    police: NearbyService[];
  };
}

export const VENUE: Venue = {
  venue_id: "taj-ahmedabad",
  name: "Taj Ahmedabad",
  address: "Satyagraha Chhavni, Gota, Ahmedabad, GJ 380060",
  geo: { lat: 23.0917, lng: 72.5269 },
  timezone: "Asia/Kolkata",
  size_sqm: 12500,
  max_occupancy: 620,
  languages: ["en", "hi", "gu"],
  nearby_services: {
    ambulance: [
      { name: "108 Emergency (Gujarat)", phone: "108", distance_km: 0.0 },
      { name: "Sterling Hospital Ambulance", phone: "+91-79-4001-1111", distance_km: 3.4 },
    ],
    fire: [{ name: "Ahmedabad Fire Dept — Sola", phone: "101", distance_km: 2.1 }],
    hospitals: [
      { name: "Sterling Hospital", distance_km: 3.4, level: 1 },
      { name: "SAL Hospital", distance_km: 4.8, level: 2 },
    ],
    police: [{ name: "Sola Police Station", phone: "100", distance_km: 1.6 }],
  },
  zones: [
    {
      zone_id: "lobby-ground",
      name: "Ground Floor Lobby",
      type: "lobby",
      floor: 0,
      capacity: 150,
      exit_count: 3,
      accessible: true,
      camera_ids: ["cam-lobby-01", "cam-lobby-02"],
      sensor_ids: ["smoke-lobby-01"],
    },
    {
      zone_id: "kitchen-main",
      name: "Main Kitchen",
      type: "kitchen",
      floor: 0,
      capacity: 35,
      exit_count: 2,
      accessible: false,
      camera_ids: ["cam-kitchen-01"],
      sensor_ids: ["smoke-kitchen-01", "heat-kitchen-01"],
    },
    {
      zone_id: "ballroom-1",
      name: "Sapphire Ballroom",
      type: "event_hall",
      floor: 1,
      capacity: 400,
      exit_count: 4,
      accessible: true,
      camera_ids: ["cam-ballroom-01", "cam-ballroom-02", "cam-ballroom-03"],
      sensor_ids: ["smoke-ballroom-01"],
    },
    {
      zone_id: "corridor-4",
      name: "Floor 4 Guest Corridor",
      type: "corridor",
      floor: 4,
      capacity: 80,
      exit_count: 2,
      accessible: true,
      camera_ids: ["cam-corr4-01"],
      sensor_ids: ["smoke-corr4-01"],
    },
  ],
  cameras: [
    { camera_id: "cam-kitchen-01", zone_id: "kitchen-main", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-lobby-01", zone_id: "lobby-ground", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-lobby-02", zone_id: "lobby-ground", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-ballroom-01", zone_id: "ballroom-1", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-ballroom-02", zone_id: "ballroom-1", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-ballroom-03", zone_id: "ballroom-1", model: "Hikvision DS-2CD", active: true },
    { camera_id: "cam-corr4-01", zone_id: "corridor-4", model: "Hikvision DS-2CD", active: true },
  ],
  responders: [
    {
      responder_id: "RSP-priya",
      display_name: "Priya Iyer",
      role: "Duty Manager",
      skills: ["FIRE_WARDEN", "FIRST_AID", "EVACUATION"],
      languages: ["hi", "en", "gu"],
      on_shift: true,
      credential_valid: true,
      distance_m: 18,
      workload: 0,
    },
    {
      responder_id: "RSP-john",
      display_name: "John Mathew",
      role: "Fire Warden",
      skills: ["FIRE_WARDEN", "EVACUATION"],
      languages: ["en", "ml"],
      on_shift: true,
      credential_valid: true,
      distance_m: 40,
      workload: 0,
    },
    {
      responder_id: "RSP-kavya",
      display_name: "Dr. Kavya Rao",
      role: "On-Call Doctor",
      skills: ["BLS", "ACLS", "FIRST_AID"],
      languages: ["en", "hi", "kn"],
      on_shift: true,
      credential_valid: true,
      distance_m: 220,
      workload: 0,
    },
    {
      responder_id: "RSP-arjun",
      display_name: "Arjun Shah",
      role: "Security Lead",
      skills: ["SECURITY", "EVACUATION"],
      languages: ["hi", "gu", "en"],
      on_shift: true,
      credential_valid: true,
      distance_m: 60,
      workload: 0,
    },
    {
      responder_id: "RSP-meera",
      display_name: "Meera Patel",
      role: "Crowd Control",
      skills: ["CROWD_CONTROL", "EVACUATION", "FIRST_AID"],
      languages: ["en", "hi", "gu"],
      on_shift: true,
      credential_valid: true,
      distance_m: 35,
      workload: 1,
    },
  ],
};

export const SEV_LABEL: Record<"S1" | "S2" | "S3" | "S4", string> = {
  S1: "S1 · CRITICAL",
  S2: "S2 · URGENT",
  S3: "S3 · MONITOR",
  S4: "S4 · NUISANCE",
};

export const zoneById = (id: string): VenueZone =>
  VENUE.zones.find((z) => z.zone_id === id) ?? {
    zone_id: id,
    name: id,
    type: "unknown",
    floor: 0,
    capacity: 0,
    exit_count: 0,
    accessible: true,
    camera_ids: [],
    sensor_ids: [],
  };

export const responderById = (id: string): VenueResponder | undefined =>
  VENUE.responders.find((r) => r.responder_id === id);
