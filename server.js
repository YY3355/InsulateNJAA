require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Supabase Client ─────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://placeholder.supabase.co',
  process.env.SUPABASE_SERVICE_KEY || 'placeholder-key'
);

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(express.json());
app.use(cors());

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 100,
  standardHeaders: true,
  message: { error: 'Too many requests, please try again later.' },
});

const calculatorLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 10,
  message: { error: 'Calculator rate limit reached. Please wait a moment.' },
});

const leadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: { error: 'Lead submission limit reached. Please try again later.' },
});

app.use('/api/v1', apiLimiter);

// ─── Climate Zone Data ───────────────────────────────────────────────────────
const CLIMATE_DATA = {
  north: {
    zone: '5A', hdd: 5600, avgWinter: 28,
    rValueAttic: 'R-49 to R-60', rValueWall: 'R-20 to R-25',
    counties: ['Sussex', 'Passaic', 'Bergen', 'Warren', 'Morris', 'Essex', 'Hudson', 'Union'],
  },
  central: {
    zone: '4A/5A', hdd: 4900, avgWinter: 32,
    rValueAttic: 'R-38 to R-60', rValueWall: 'R-15 to R-21',
    counties: ['Hunterdon', 'Somerset', 'Middlesex', 'Mercer', 'Monmouth', 'Ocean'],
  },
  south: {
    zone: '4A', hdd: 4200, avgWinter: 35,
    rValueAttic: 'R-38 to R-49', rValueWall: 'R-13 to R-21',
    counties: ['Burlington', 'Camden', 'Gloucester', 'Atlantic', 'Cumberland', 'Salem', 'Cape May'],
  },
};

const ZIP_TO_COUNTY = {
  '07102': 'Essex', '07302': 'Hudson', '07501': 'Passaic', '07201': 'Union',
  '08817': 'Middlesex', '07095': 'Middlesex', '08753': 'Ocean', '08608': 'Mercer',
  '08002': 'Camden', '07601': 'Bergen', '08901': 'Middlesex', '07960': 'Morris',
  '08540': 'Mercer', '07701': 'Monmouth', '07042': 'Essex', '08807': 'Somerset',
  '08054': 'Burlington', '08701': 'Ocean', '08401': 'Atlantic', '08204': 'Cape May',
  '08822': 'Hunterdon', '07860': 'Sussex', '08096': 'Gloucester', '08101': 'Camden',
  '07882': 'Warren',
};

const INSULATION_R_VALUES = {
  'none': 0, 'old-fiberglass': 8, 'fiberglass-ok': 19,
  'blown-cellulose': 22, 'spray-foam-open': 25, 'spray-foam-closed': 38,
};

function getClimateByCounty(county) {
  for (const [region, data] of Object.entries(CLIMATE_DATA)) {
    if (data.counties.includes(county)) return { region, ...data };
  }
  return { region: 'central', ...CLIMATE_DATA.central };
}

function getClimateByZip(zip) {
  const county = ZIP_TO_COUNTY[zip];
  if (!county) return { region: 'central', ...CLIMATE_DATA.central, county: 'Unknown' };
  return { ...getClimateByCounty(county), county };
}


// ============================================================================
// ENDPOINTS
// ============================================================================

// ─── Health Check ────────────────────────────────────────────────────────────
app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok', service: 'InsulateNJ API', version: '1.0.0' });
});


// ─── 1. INSULATION SAVINGS CALCULATOR ────────────────────────────────────────
// POST /api/v1/calculate/insulation
app.post('/api/v1/calculate/insulation', calculatorLimiter, async (req, res) => {
  try {
    const { zip, square_feet, insulation_type, attic_condition } = req.body;

    // Validation
    if (!zip || !square_feet) {
      return res.status(400).json({ error: 'zip and square_feet are required' });
    }
    const sqft = parseInt(square_feet);
    if (isNaN(sqft) || sqft < 200 || sqft > 20000) {
      return res.status(400).json({ error: 'square_feet must be between 200 and 20000' });
    }

    const climate = getClimateByZip(zip);
    const currentR = INSULATION_R_VALUES[insulation_type] || 0;
    const targetR = parseInt(climate.rValueAttic.split('R-')[1]) || 49;
    
    const conditionMultiplier = {
      poor: 1.4, fair: 1.15, good: 1.0, excellent: 0.85,
    }[attic_condition] || 1.15;

    // ASHRAE-lite heat loss calculation
    const heatLossBTU = ((sqft * (targetR - currentR) * climate.hdd * 24) / (targetR || 1)) * conditionMultiplier;
    const annualCostCurrent = (heatLossBTU / 100000) * 1.2;
    const annualCostUpgraded = (heatLossBTU / 100000) * 0.35;
    const estimatedSavings = Math.max(200, Math.min(Math.round(annualCostCurrent - annualCostUpgraded), 3200));
    const urgencyScore = Math.min(100, Math.round(((targetR - currentR) / targetR) * 100 * conditionMultiplier));

    const result = {
      estimated_heat_loss_btu: Math.round(heatLossBTU),
      estimated_annual_savings: estimatedSavings,
      recommended_r_value: `R-${targetR}`,
      current_r_value: `R-${currentR}`,
      urgency_score: urgencyScore,
      climate_zone: climate.zone,
      heating_degree_days: climate.hdd,
      county: climate.county,
      region: climate.region,
      cost_estimate: {
        low: Math.round(sqft * 1.0),
        mid: Math.round(sqft * 2.0),
        high: Math.round(sqft * 3.5),
      },
      payback_years: Math.round((sqft * 2.0) / estimatedSavings * 10) / 10,
    };

    // Log session to Supabase (non-blocking)
    supabase.from('calculator_sessions').insert({
      session_type: 'insulation',
      zip,
      input_data: { zip, square_feet: sqft, insulation_type, attic_condition },
      result_data: result,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      referrer: req.get('referer'),
    }).then(() => {}).catch(() => {});

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('Calculator error:', err);
    res.status(500).json({ error: 'Calculation failed' });
  }
});


// ─── 2. IAQ SCORE CALCULATOR ────────────────────────────────────────────────
// POST /api/v1/calculate/iaq
app.post('/api/v1/calculate/iaq', calculatorLimiter, async (req, res) => {
  try {
    const { home_age, pets, smokers, humidity, allergies, zip } = req.body;

    if (!home_age) {
      return res.status(400).json({ error: 'home_age is required' });
    }

    let score = 75;
    if (home_age === 'pre-1980') score -= 20;
    else if (home_age === '1980-2000') score -= 10;
    else if (home_age === '2000-2015') score -= 5;
    if (pets === true || pets === 'yes') score -= 10;
    if (smokers === true || smokers === 'yes') score -= 20;
    if (humidity === 'high') score -= 15;
    else if (humidity === 'low') score -= 5;
    if (allergies === true || allergies === 'yes') score -= 10;
    score = Math.max(10, Math.min(95, score));

    const moldRisk = score < 40 ? 'HIGH' : score < 60 ? 'MODERATE' : 'LOW';
    const grade = score >= 80 ? 'A' : score >= 60 ? 'B' : score >= 40 ? 'C' : 'D';
    
    const solutions = [];
    if (score < 50) {
      solutions.push(
        { name: 'Air Scrubber System', priority: 'high', estimated_cost: '$800–$2,500' },
        { name: 'Professional Duct Cleaning', priority: 'high', estimated_cost: '$300–$600' },
        { name: 'HEPA Filtration Upgrade', priority: 'medium', estimated_cost: '$200–$800' },
        { name: 'Dehumidifier Installation', priority: 'medium', estimated_cost: '$150–$500' },
      );
    } else if (score < 70) {
      solutions.push(
        { name: 'Air Purifier', priority: 'medium', estimated_cost: '$200–$600' },
        { name: 'Dehumidifier', priority: 'medium', estimated_cost: '$150–$400' },
        { name: 'Duct Inspection', priority: 'low', estimated_cost: '$100–$300' },
      );
    } else {
      solutions.push(
        { name: 'Regular Filter Changes', priority: 'low', estimated_cost: '$20–$60/quarter' },
        { name: 'Annual HVAC Maintenance', priority: 'low', estimated_cost: '$100–$200' },
      );
    }

    const result = {
      iaq_score: score,
      grade,
      mold_risk: moldRisk,
      dust_load: score < 40 ? 'heavy' : score < 60 ? 'moderate' : 'light',
      recommended_solutions: solutions,
    };

    // Log session
    supabase.from('calculator_sessions').insert({
      session_type: 'iaq',
      zip: zip || null,
      input_data: { home_age, pets, smokers, humidity, allergies },
      result_data: result,
      ip_address: req.ip,
      user_agent: req.get('user-agent'),
      referrer: req.get('referer'),
    }).then(() => {}).catch(() => {});

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('IAQ error:', err);
    res.status(500).json({ error: 'IAQ calculation failed' });
  }
});


// ─── 3. LEAD CAPTURE & ROUTING ──────────────────────────────────────────────
// POST /api/v1/leads
app.post('/api/v1/leads', leadLimiter, async (req, res) => {
  try {
    const {
      name, email, phone, address, zip,
      source, source_url,
      utm_source, utm_medium, utm_campaign,
      calculator_data, iaq_data,
    } = req.body;

    // Validation
    if (!name || !email || !zip) {
      return res.status(400).json({ error: 'name, email, and zip are required' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Get city/county from ZIP
    const county = ZIP_TO_COUNTY[zip] || null;
    let city = null;
    if (county) {
      const { data: cityData } = await supabase
        .from('nj_cities')
        .select('name')
        .eq('zip', zip)
        .single();
      city = cityData?.name || null;
    }

    // Insert lead
    const { data: lead, error: insertError } = await supabase
      .from('leads')
      .insert({
        name, email, phone, address,
        city, county, zip,
        source: source || 'direct',
        source_url,
        utm_source, utm_medium, utm_campaign,
        calculator_data: calculator_data || {},
        iaq_data: iaq_data || {},
        ip_address: req.ip,
        user_agent: req.get('user-agent'),
      })
      .select()
      .single();

    if (insertError) {
      console.error('Lead insert error:', insertError);
      return res.status(500).json({ error: 'Failed to save lead' });
    }

    // Route the lead (ECI gets first shot)
    let assignedContractorId = process.env.ECI_CONTRACTOR_ID;
    
    // If no ECI ID set, use the routing function
    if (!assignedContractorId) {
      const { data: routeData } = await supabase
        .rpc('route_lead', { lead_id: lead.id });
      assignedContractorId = routeData;
    } else {
      // Assign to ECI directly
      await supabase
        .from('leads')
        .update({
          assigned_contractor_id: assignedContractorId,
          routed_at: new Date().toISOString(),
          status: 'routed',
          sold_to: 'eci',
        })
        .eq('id', lead.id);
    }

    // TODO: Send email notification
    // TODO: Push to Jobber CRM via webhook
    // await pushToJobber(lead);

    res.json({
      success: true,
      message: 'Your quote request has been submitted. A local expert will contact you shortly.',
      lead_id: lead.id,
    });

  } catch (err) {
    console.error('Lead capture error:', err);
    res.status(500).json({ error: 'Lead submission failed' });
  }
});


// ─── 4. CONTRACTORS DIRECTORY ────────────────────────────────────────────────
// GET /api/v1/contractors
app.get('/api/v1/contractors', async (req, res) => {
  try {
    const { county, city, service, sort, limit: queryLimit } = req.query;
    const limitNum = Math.min(parseInt(queryLimit) || 50, 100);

    let query = supabase
      .from('contractors')
      .select('*, contractor_services(service_id, services(name, slug, category))')
      .eq('is_active', true)
      .limit(limitNum);

    if (county) query = query.eq('county', county);
    if (city) query = query.eq('city', city);
    if (sort === 'reviews') {
      query = query.order('review_count', { ascending: false });
    } else {
      query = query.order('is_featured', { ascending: false }).order('rating', { ascending: false });
    }

    const { data, error } = await query;
    if (error) throw error;

    // Flatten services
    const contractors = (data || []).map(c => ({
      ...c,
      services: (c.contractor_services || []).map(cs => cs.services?.name).filter(Boolean),
      contractor_services: undefined,
    }));

    res.json({ success: true, count: contractors.length, data: contractors });

  } catch (err) {
    console.error('Contractors error:', err);
    res.status(500).json({ error: 'Failed to fetch contractors' });
  }
});

// GET /api/v1/contractors/:slug
app.get('/api/v1/contractors/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('contractors')
      .select('*, contractor_services(service_id, services(name, slug, category)), reviews(*)')
      .eq('slug', req.params.slug)
      .eq('is_active', true)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Contractor not found' });
    }

    const contractor = {
      ...data,
      services: (data.contractor_services || []).map(cs => cs.services).filter(Boolean),
      recent_reviews: (data.reviews || []).filter(r => r.is_published).slice(0, 10),
      contractor_services: undefined,
      reviews: undefined,
    };

    res.json({ success: true, data: contractor });

  } catch (err) {
    console.error('Contractor detail error:', err);
    res.status(500).json({ error: 'Failed to fetch contractor' });
  }
});


// ─── 5. CITY PAGES ──────────────────────────────────────────────────────────
// GET /api/v1/cities
app.get('/api/v1/cities', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('nj_cities')
      .select('*')
      .eq('is_active', true)
      .order('population', { ascending: false });

    if (error) throw error;
    res.json({ success: true, count: data.length, data });

  } catch (err) {
    console.error('Cities error:', err);
    res.status(500).json({ error: 'Failed to fetch cities' });
  }
});

// GET /api/v1/cities/:slug
app.get('/api/v1/cities/:slug', async (req, res) => {
  try {
    const { data: city, error } = await supabase
      .from('nj_cities')
      .select('*')
      .eq('slug', req.params.slug)
      .single();

    if (error || !city) {
      return res.status(404).json({ error: 'City not found' });
    }

    // Get contractors for this city's county
    const { data: contractors } = await supabase
      .from('contractors')
      .select('id, name, slug, city, rating, review_count, is_verified, is_featured, response_time, phone')
      .eq('county', city.county)
      .eq('is_active', true)
      .order('is_featured', { ascending: false })
      .order('rating', { ascending: false });

    res.json({
      success: true,
      data: {
        city,
        contractors: contractors || [],
        seo: {
          title: city.meta_title,
          description: city.meta_description,
          h1: `Best Insulation Contractors in ${city.name}, NJ`,
          schema_type: 'LocalBusiness',
        },
      },
    });

  } catch (err) {
    console.error('City detail error:', err);
    res.status(500).json({ error: 'Failed to fetch city data' });
  }
});


// ─── 6. CLIMATE DATA BY ZIP ─────────────────────────────────────────────────
// GET /api/v1/climate/:zip
app.get('/api/v1/climate/:zip', (req, res) => {
  const climate = getClimateByZip(req.params.zip);
  res.json({ success: true, data: climate });
});


// ─── 7. DASHBOARD STATS (protected) ─────────────────────────────────────────
// GET /api/v1/stats
app.get('/api/v1/stats', async (req, res) => {
  try {
    // Simple API key auth for now
    const authKey = req.headers['authorization'];
    if (authKey !== `Bearer ${process.env.SUPABASE_SERVICE_KEY}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { data, error } = await supabase.rpc('get_dashboard_stats');
    if (error) throw error;

    res.json({ success: true, data });

  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});


// ─── 8. WIDGET ENDPOINT (for embeds) ────────────────────────────────────────
// POST /api/v1/widget/calculate
app.post('/api/v1/widget/calculate', calculatorLimiter, async (req, res) => {
  const widgetKey = req.headers['x-widget-key'];
  
  // Track widget usage
  if (widgetKey) {
    supabase
      .from('widget_installs')
      .update({ impressions: supabase.rpc('increment_counter') })
      .eq('api_key', widgetKey)
      .then(() => {}).catch(() => {});
  }

  // Reuse calculator logic
  req.body.source = 'widget';
  return app._router.handle(
    Object.assign(req, { url: '/api/v1/calculate/insulation' }),
    res,
    () => {}
  );
});


// ─── Error handling ──────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', docs: '/api/v1/health' });
});


// ─── Start Server ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║   InsulateNJ API Server                         ║
  ║   Running on http://localhost:${PORT}              ║
  ║                                                  ║
  ║   Endpoints:                                     ║
  ║   POST /api/v1/calculate/insulation              ║
  ║   POST /api/v1/calculate/iaq                     ║
  ║   POST /api/v1/leads                             ║
  ║   GET  /api/v1/contractors                       ║
  ║   GET  /api/v1/contractors/:slug                 ║
  ║   GET  /api/v1/cities                            ║
  ║   GET  /api/v1/cities/:slug                      ║
  ║   GET  /api/v1/climate/:zip                      ║
  ║   GET  /api/v1/stats                             ║
  ╚══════════════════════════════════════════════════╝
  `);
});

module.exports = app;
