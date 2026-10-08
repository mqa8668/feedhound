// Scrubbed used-car post texts (no real phone numbers) and the attributes the
// regex extractor must produce with the resolved `cars` schema, exactly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { attributeSchemaZ, resolveSchema, type AttributeSchema, type Attributes } from "../attributes";

interface TaxNode {
  slug: string;
  attributes?: unknown;
  children?: TaxNode[];
}

/** Resolved (inherited) attribute schema of the category `slug` in `config/taxonomy.yaml`. Test helper. */
export function taxonomySchema(slug: string): AttributeSchema {
  const raw = readFileSync(fileURLToPath(new URL("../../../../config/taxonomy.yaml", import.meta.url)), "utf8");
  const tree = new Map<string, string>();
  const byCategory = new Map<string, AttributeSchema>();
  const walk = (n: TaxNode, parent: string): void => {
    const path = parent ? `${parent}.${n.slug.replaceAll("-", "_")}` : n.slug.replaceAll("-", "_");
    tree.set(n.slug, path);
    if (n.attributes) byCategory.set(n.slug, attributeSchemaZ.parse(n.attributes));
    for (const c of n.children ?? []) walk(c, path);
  };
  for (const n of parse(raw) as TaxNode[]) walk(n, "");
  return resolveSchema(slug, tree, byCategory);
}

export interface CarPostFixture {
  name: string;
  text: string;
  expected: Attributes;
}

export const carPosts: CarPostFixture[] = [
  {
    name: "sx keyword, odo 6v, number-less district Q7",
    text: "Bán Toyota Vios 1.5E số sàn sx 2016, odo 6v, xe gia đình Q7",
    expected: { make: "toyota", model: "vios", body: "sedan", year: 2016, odo_km: 60000, transmission: "mt", region: "hcm" },
  },
  {
    name: "santafe, đời, 2v1 km, AT, non-HCM province",
    text: "Hyundai santafe đời 2015 máy dầu AT đi 2v1 km 7 chỗ Biên Hòa",
    expected: { make: "hyundai", model: "santa_fe", body: "suv", year: 2015, fuel: "diesel", transmission: "at", odo_km: 21000, seats: 7, region: "dong_nai" },
  },
  {
    name: "cerato, số tự động, phone-adjacent year is not a year",
    text: "Kia cerato số tự động, lh 0909 2015 88",
    expected: { make: "kia", model: "k3", body: "sedan", transmission: "at" },
  },
  {
    name: "crv, bare year, 62.000km, HCM district",
    text: "Honda CRV 2019 bản L, 62.000km, số tự động, xe công ty Bình Thạnh",
    expected: { make: "honda", model: "cr_v", body: "suv", year: 2019, odo_km: 62000, transmission: "at", region: "hcm" },
  },
  {
    name: "cx5, 6 vạn, xăng, Hà Nội",
    text: "Mazda cx5 2.0 sx 2018 đi 6 vạn, số tự động, máy xăng, Hà Nội",
    expected: { make: "mazda", model: "cx_5", body: "suv", year: 2018, odo_km: 60000, transmission: "at", fuel: "gas", region: "ha_noi" },
  },
  {
    name: "ranger, bán tải, 4v5, quận 9",
    text: "Cần bán Ford Ranger 2020 bán tải, số sàn, đi 4v5, quận 9",
    expected: { make: "ford", model: "ranger", body: "pickup", year: 2020, odo_km: 45000, transmission: "mt", region: "hcm" },
  },
  {
    name: "fadil, 15.000 km, 5 chỗ, Cần Thơ",
    text: "VinFast Fadil 2021 chạy 15.000 km, 5 chỗ, Cần Thơ",
    expected: { make: "vinfast", model: "fadil", body: "hatchback", year: 2021, odo_km: 15000, seats: 5, region: "can_tho" },
  },
  {
    name: "innova, odo keyword, 8 chỗ, Đồng Nai",
    text: "Toyota Innova 2.0E 2017 số sàn 8 chỗ odo 85000 km Đồng Nai",
    expected: { make: "toyota", model: "innova", body: "mpv", year: 2017, odo_km: 85000, transmission: "mt", seats: 8, region: "dong_nai" },
  },
  {
    name: "mercedes alias, model not in catalogue",
    text: "Mercedes C200 đời 2015 xe lướt giá 600tr",
    expected: { make: "mercedes_benz", year: 2015 },
  },
  {
    name: "swift, 30k km, Bình Dương",
    text: "Bán Suzuki Swift 2019 tự động, đi 30k km, Bình Dương",
    expected: { make: "suzuki", model: "swift", body: "hatchback", year: 2019, transmission: "at", odo_km: 30000, region: "binh_duong" },
  },
  {
    name: "morning, số sàn, Q1",
    text: "Kia Morning 2012 số sàn, Q1",
    expected: { make: "kia", model: "morning", body: "hatchback", year: 2012, transmission: "mt", region: "hcm" },
  },
  {
    name: "EV, VF e34, odo keyword, Hải Phòng",
    text: "Xe điện VinFast VF e34 sx 2022 odo 20.000km, Hải Phòng",
    expected: { make: "vinfast", model: "vf_e34", body: "suv", year: 2022, fuel: "ev", odo_km: 20000, region: "hai_phong" },
  },
  {
    name: "MT keyword",
    text: "Hyundai Accent 1.4 MT 2018 xe gia đình",
    expected: { make: "hyundai", model: "accent", body: "sedan", year: 2018, transmission: "mt" },
  },
  {
    name: "santa fe (two words), sx glued to year",
    text: "Hyundai Santa Fe 2.2 sx2017 full dầu",
    expected: { make: "hyundai", model: "santa_fe", body: "suv", year: 2017 },
  },
  {
    name: "cr-v with dash, 9v",
    text: "Honda CR-V 2.4 TG 2013 odo 9v",
    expected: { make: "honda", model: "cr_v", body: "suv", year: 2013, odo_km: 90000 },
  },
  {
    name: "k3",
    text: "Kia K3 đời 2016 AT",
    expected: { make: "kia", model: "k3", body: "sedan", year: 2016, transmission: "at" },
  },
];
