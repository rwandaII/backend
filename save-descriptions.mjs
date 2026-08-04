import 'dotenv/config';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const descriptions = [
  [1, "Nestlé's Stage 1 infant formula for babies from birth, built around the OPTIPRO whey-based protein blend alongside 2'FL and BL probiotic cultures to support early digestion and immunity. Enriched with DHA for brain development and 13 vitamins for balanced early nutrition."],
  [403, "A strawberry-flavoured lip balm in a squeezable 10g tube that moisturises dry, chapped lips and includes SPF 15 for sun protection. Formulated with petrolatum, lanolin and beeswax to form a long-lasting barrier that soothes and helps lips heal."],
  [385, "A low-alcohol topical solution containing 5% Minoxidil, aimed at men noticing early thinning at the crown. Applied directly to the scalp, it's formulated to reactivate follicles and support visible regrowth with consistent use; this pack covers a 3-month supply."],
  [378, "A pack of 5 disposable twin-blade razors offering a close, comfortable shave with a lubricating strip enriched with aloe vera for sensitive skin. The slim, fixed head and ergonomic handle make them easy to control for everyday grooming or travel."],
  [675, "A granulated sugar substitute that can be measured spoon-for-spoon like sugar, at just 2 calories per teaspoon. Suitable for hot drinks, baking, and sprinkling over cereal or fruit, and suitable for vegans."],
  [876, "A deep-conditioning hair mask infused with argan oil, shea butter, coconut oil, olive oil and keratin to intensely moisturise and strengthen dry, textured hair. Applied after shampooing and left in for around 10 minutes, it helps restore softness and manageability from root to tip."],
  [651, "A fast-acting insect spray that kills flying and crawling pests, including flies, mosquitoes, wasps, ants and spiders, without leaving a strong chemical smell. Suitable for indoor and outdoor use around the home."],
  [317, "A box of 60 ultra-thin, contoured disposable nursing pads with a super-absorbent core that locks in breast milk and keeps skin dry. Each pad is individually wrapped for hygiene, with adhesive strips to stay securely in place under clothing."],
  [701, "A daily fluoride toothpaste for sensitive teeth that gently polishes away surface stains to help restore natural whiteness. Contains potassium nitrate to calm nerve sensitivity over time and sodium fluoride to strengthen enamel and protect against decay."],
  [976, "A topical ointment containing camphor, menthol and eucalyptus oil that provides temporary relief from cough, nasal congestion and minor aches when rubbed on the chest, throat or back. Comes in a 50g jar for everyday use during colds and flu season."],
];

for (const [id, description] of descriptions) {
  await pool.query('UPDATE products SET description = $1, updated_at = now() WHERE id = $2', [description, id]);
}
console.log(`Saved ${descriptions.length} descriptions.`);
await pool.end();
