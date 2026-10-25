/**
 * Plain-language names for the standard chart of accounts, shown in reports. Display only: the ledger
 * accounts keep their codes and stored names, so renaming here never changes history. Accounts the
 * team created themselves show their own names.
 */
const RU: Record<string, string> = {
  "4000": "Выручка агентства",
  "4010": "Management fee (вознаграждение за ведение)",
  "4020": "Выручка Influence",
  "4030": "Выручка AI Production",
  "4040": "Выручка Crypto Marketing / медиабаинг",
  "4050": "Выручка Clipping / UBT",
  "4090": "Прочая выручка от клиентов",
  "4900": "Прочие доходы",
  "5000": "Зарплаты проектной команды",
  "5050": "Бонусы проектной команды",
  "5100": "Подрядчики и фрилансеры",
  "5200": "Инструменты для выполнения клиентских работ",
  "5300": "Прямые расходы на кампании",
  "5400": "Выплаты инфлюенсерам",
  "5500": "Выплаты стримерам",
  "5900": "Прочие прямые расходы на проекты",
  "6000": "Административные зарплаты",
  "6050": "Бонусы административной команды",
  "6100": "Софт и подписки",
  "6200": "Маркетинг агентства",
  "6300": "Аренда и офис",
  "6400": "Банковские и платёжные комиссии",
  "6500": "Внутренние операционные расходы",
  "6600": "Администрирование",
  "6700": "Развитие бизнеса",
  "6800": "Расходы на HR",
  "6900": "Прочие операционные расходы",
  "7000": "Амортизация оборудования",
  "7100": "Амортизация нематериальных активов",
  "8000": "Проценты по займам",
  "8100": "Процентный доход",
  "8500": "Курсовые разницы",
  "9000": "Налог на прибыль",
}

/** Seeded English names; a renamed account (name differs) keeps the team's own name. */
const SEEDED: Record<string, string> = {
  "4000": "Agency revenue", "4010": "Management fees", "4020": "Influencer marketing revenue", "4030": "AI production revenue", "4040": "Media buying revenue", "4050": "Clipping revenue", "4090": "Other operating revenue", "4900": "Other income",
  "5000": "Delivery payroll", "5050": "Delivery bonuses", "5100": "Contractors and freelancers", "5200": "Production tools and services", "5300": "Direct campaign expenses", "5400": "Influencer payments", "5500": "Streamer payments", "5900": "Other direct costs",
  "6000": "Overhead payroll", "6050": "Employee bonuses", "6100": "Software and subscriptions", "6200": "Marketing", "6300": "Rent and office", "6400": "Bank and payment fees", "6500": "Operational expenses", "6600": "Administration", "6700": "Business development", "6800": "HR expenses", "6900": "Other operating expenses",
  "7000": "Depreciation", "7100": "Amortization", "8000": "Interest expense", "8100": "Interest income", "8500": "FX gains and losses", "9000": "Income tax",
}

export function accountLabel(code: string, name: string, locale: "ru" | "en") {
  if (locale !== "ru") return name
  return SEEDED[code] === name && RU[code] ? RU[code] : name
}
