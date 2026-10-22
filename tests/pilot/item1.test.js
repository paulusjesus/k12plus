// Item 1 acceptance tests: pilot structure. Runs against a local Postgres (PGlite)
// loaded with a stand-in of the live schema plus the new migration.
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '../../backend/migrations/20261023_pilot_structure.sql');
let pass = 0, fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  PASS', name); } else { fail++; console.log('  FAIL', name, extra !== undefined ? JSON.stringify(extra) : ''); } };

(async () => {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, 'bootstrap.sql'), 'utf8'));

  // ---------- seed: schools and accounts as they exist before the migration ----------
  const U = {};
  const mk = async (key, role, opts = {}) => {
    const r = await db.query('insert into auth.users (email) values ($1) returning id', [opts.email || key + '@test.na']);
    U[key] = r.rows[0].id;
    await db.query(`insert into profiles (id, username, role, grade, school_id, phone, country, learner_uid)
                    values ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [U[key], opts.name || key, role, opts.grade || null, opts.school || null, opts.phone || null, 'Namibia', opts.uid || null]);
  };
  const S = {};
  for (const [k, n, r] of [['tsandiR', 'Tsandi Rural SS', 'Omusati (Tsandi)'], ['outapiU', 'Outapi Urban SS', 'Omusati (Outapi)'],
    ['okahao', 'Okahao SS', 'Omusati (Okahao)'], ['whk', 'Windhoek High', 'Khomas (Windhoek)'],
    ['aus', 'Aus Combined', 'ǁKaras (Aus)'], ['pta', 'Pretoria Boys', 'Gauteng (Pretoria)']]) {
    S[k] = (await db.query('insert into schools (name, region, country) values ($1,$2,$3) returning id', [n, r, k === 'pta' ? 'South Africa' : 'Namibia'])).rows[0].id;
  }
  await mk('admin', 'educator');
  await db.query("update profiles set role = 'learner' where id = $1", [U.admin]); // placeholder, set admin after migration
  await mk('t1', 'educator', { name: 'Ms Amutenya', phone: '081 111 2222', school: S.tsandiR });
  await mk('t2', 'educator', { name: 'Mr Shilongo', email: 'shilongo@school.na' });
  await mk('t3', 'educator', { name: 'Ms Nangolo', school: S.outapiU });
  await mk('t4', 'educator', { name: 'Mr Iipinge', school: S.outapiU });
  await mk('tOther', 'educator', { name: 'Ms Windhoek', school: S.whk });
  await mk('champ', 'educator', { name: 'Mr Champion', phone: '0812223333' });
  await mk('champK', 'educator', { name: 'Ms Khomas Champion' });
  await mk('parent', 'parent', { name: 'A Parent' });
  await mk('l1', 'learner', { name: 'Ndapewa', grade: 11, uid: 'K12-NA-AAA111' });
  await mk('l2', 'learner', { name: 'Tomas', grade: 12, uid: 'K12-NA-BBB222', phone: '0813334444' });
  await mk('l3', 'learner', { name: 'Selma', grade: null, uid: 'K12-NA-CCC333', school: S.whk });
  await mk('l4', 'learner', { name: 'Petrus', grade: 11, uid: 'K12-NA-DDD444' });
  const schoolsBefore = (await db.query('select id, name, region, plan, country from schools order by id')).rows;

  // ---------- apply the migration ----------
  const t0 = Date.now();
  await db.exec(fs.readFileSync(MIG, 'utf8'));
  console.log(`Migration applied in ${Date.now() - t0} ms`);
  await db.query("update profiles set role = 'admin' where id = $1", [U.admin]); // done by staff in the table editor

  // run SQL as a signed-in user (or anon), exactly as the API would
  const as = async (who, sql, params = []) => {
    return db.transaction(async (tx) => {
      if (who === 'anon') {
        await tx.query("select set_config('request.jwt.claims', '{\"role\":\"anon\"}', true)");
        await tx.query('set local role anon');
      } else {
        await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U[who], role: 'authenticated' })]);
        await tx.query('set local role authenticated');
      }
      return (await tx.query(sql, params)).rows;
    });
  };
  const tryAs = async (who, sql, params) => { try { return { rows: await as(who, sql, params) }; } catch (e) { return { err: e.message }; } };
  const rpc1 = async (who, sql, params) => { const r = await tryAs(who, sql, params); return r.err ? r : { v: Object.values(r.rows[0])[0] }; };

  console.log('\n1. Regions and schools');
  const regs = await as('anon', 'select count(*)::int n from regions');
  ok(regs[0].n === 14, '14 regions readable by anyone');
  const back = (await db.query('select name, region_id from schools order by name')).rows;
  const rid = Object.fromEntries(back.map((r) => [r.name, r.region_id]));
  ok(rid['Tsandi Rural SS'] === 10 && rid['Windhoek High'] === 6 && rid['Aus Combined'] === 3, 'region filled in from the text (Omusati, Khomas, ǁKaras)');
  ok(rid['Pretoria Boys'] === null, 'South African school left without a Namibian region');
  const schoolsAfter = (await db.query('select id, name, region, plan, country from schools order by id')).rows;
  ok(JSON.stringify(schoolsBefore) === JSON.stringify(schoolsAfter), 'existing school data unchanged by the migration');

  console.log('\n2. Setting up a test region (Omusati: 2 schools, 4 classes, 4 teachers, 1 champion)');
  const setupSql = 'select pilot_setup_region($1::smallint, $2::jsonb)';
  const schoolsArg = JSON.stringify([{ school_id: S.tsandiR, setting: 'rural' }, { school_id: S.outapiU, setting: 'urban' }]);
  let r = await rpc1('t1', setupSql, [10, schoolsArg]);
  ok(r.err && /administrators/.test(r.err), 'a teacher cannot set up a region', r);
  r = await rpc1('admin', setupSql, [10, JSON.stringify([{ school_id: S.whk, setting: 'urban' }])]);
  ok(r.err && /another region/.test(r.err), 'a school from another region is refused', r);

  const started = Date.now();
  let actions = 0;
  r = await rpc1('admin', setupSql, [10, schoolsArg]); actions++;
  ok(!r.err && r.v.schools.length === 2, 'administrator sets up the region in one step', r.err);
  const classes = r.v.schools.flatMap((s) => s.classes.map((c) => ({ ...c, school: s.name })));
  ok(classes.length === 4, 'four classes created (Grade 11 and 12 mathematics in each school)');
  ok(classes.every((c) => /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/.test(c.code)) && new Set(classes.map((c) => c.code)).size === 4,
    'each class has its own easy-to-read 6-character code', classes.map((c) => c.code));
  const C = {};
  for (const c of classes) C[(c.school.startsWith('Tsandi') ? 'tsandi' : 'outapi') + c.grade] = c;
  const again = await rpc1('admin', setupSql, [10, schoolsArg]);
  ok(!again.err && again.v.schools.flatMap((s) => s.classes).length === 4, 'running the set-up again does not duplicate classes');

  const assign = (who, cls, ident) => rpc1(who, 'select pilot_assign_teacher($1::uuid, $2)', [cls, ident]);
  r = await assign('admin', C.tsandi11.id, '081 111 2222'); actions++;
  ok(!r.err, 'assign teacher by mobile number', r);
  r = await assign('admin', C.tsandi12.id, 'shilongo@school.na'); actions++;
  ok(!r.err, 'assign teacher by email address (teacher had no school yet)', r);
  r = await assign('admin', C.outapi11.id, 't3@test.na'); actions++;
  ok(!r.err, 'assign third teacher', r);
  r = await assign('admin', C.outapi12.id, 't4@test.na'); actions++;
  ok(!r.err, 'assign fourth teacher', r);
  r = await assign('admin', C.outapi12.id, 'tother@test.na');
  ok(r.err && /another school/.test(r.err), 'a teacher from another school is refused', r);
  r = await assign('admin', C.outapi12.id, 'parent@test.na');
  ok(r.err && /not registered as a teacher/.test(r.err), 'a parent account cannot be a teacher', r);
  r = await assign('admin', C.outapi12.id, 'nobody@test.na');
  ok(r.err && /sign up/.test(r.err), 'unknown teacher gets a clear message', r);
  const t2school = (await db.query('select school_id from profiles where id = $1', [U.t2])).rows[0].school_id;
  ok(t2school === S.tsandiR, "teacher without a school is linked to the class's school");

  r = await rpc1('admin', 'select pilot_set_champion($1::smallint, $2)', [10, '081 222 3333']); actions++;
  ok(!r.err && r.v.champion === 'Mr Champion', 'appoint the regional champion', r);
  await rpc1('admin', 'select pilot_set_champion($1::smallint, $2)', [6, 'champk@test.na']);
  const elapsed = Date.now() - started;
  console.log(`  Set-up took ${actions} actions and ${elapsed} ms of server time`);

  console.log('\n3. Regional champion sees their own region only');
  r = await rpc1('champ', 'select pilot_region_detail(10::smallint)');
  ok(!r.err && r.v.schools.length === 2 && r.v.schools.every((s) => s.classes.length === 2), 'champion sees the two schools and four classes', r.err);
  ok(!r.err && r.v.schools.flatMap((s) => s.classes).every((c) => c.teachers.length === 1), 'champion sees each class teacher');
  r = await rpc1('champK', 'select pilot_region_detail(10::smallint)');
  ok(r.err && /own region/.test(r.err), 'a champion from another region sees nothing', r);
  r = await rpc1('t1', 'select pilot_region_detail(10::smallint)');
  ok(r.err, 'a teacher who is not a champion cannot see the region view');
  r = await rpc1('champ', 'select pilot_overview()');
  ok(r.err, 'a champion cannot see the whole-country overview');
  r = await rpc1('champ', 'select pilot_set_champion(10::smallint, $1)', ['0812223333']);
  ok(r.err, 'a champion cannot appoint champions');

  console.log('\n4. Learners join');
  const join = (who, code) => rpc1(who, 'select pilot_join_class($1)', [code]);
  const codeLower = C.tsandi11.code.toLowerCase().slice(0, 3) + '-' + C.tsandi11.code.toLowerCase().slice(3);
  r = await join('l1', codeLower);
  ok(!r.err && r.v.class === 'Grade 11 Mathematics', 'learner joins with the class code (typed in lower case with a dash)', r);
  r = await join('l2', C.tsandi11.code);
  ok(r.err && /Grade 11/.test(r.err), 'a Grade 12 learner cannot join a Grade 11 class', r);
  r = await join('l1', C.outapi11.code);
  ok(r.err && /already in/.test(r.err), 'a learner cannot be in two pilot classes', r);
  r = await join('l4', 'ZZZZZZ');
  ok(r.err && /not found/.test(r.err), 'a wrong code gets a clear message', r);
  r = await join('parent', C.tsandi11.code);
  ok(r.err && /Only learner/.test(r.err), 'a parent account cannot join a class', r);
  r = await join('l3', C.outapi12.code);
  const l3 = (await db.query('select grade, school_id from profiles where id = $1', [U.l3])).rows[0];
  ok(!r.err && l3.grade === 12 && l3.school_id === S.outapiU, 'learner with no grade gets the class grade and the class school', r);

  const addL = (who, cls, ident) => rpc1(who, 'select pilot_add_learner($1::uuid, $2)', [cls, ident]);
  r = await addL('t2', C.tsandi12.id, '0813334444');
  ok(!r.err, 'teacher adds a learner by mobile number (shared or basic phone)', r);
  r = await addL('t3', C.tsandi11.id, 'K12-NA-DDD444');
  ok(r.err && /teachers/.test(r.err), "a teacher cannot add learners to another teacher's class", r);
  r = await addL('t1', C.tsandi11.id, 'k12-na-ddd444');
  ok(!r.err, 'teacher adds a learner by k12plus ID', r);

  console.log('\n5. Every learner record shows region, school, setting and class');
  const recs = (await tryAs('admin', 'select * from pilot_learner_records()')).rows;
  ok(recs.length === 4, 'four learners enrolled', recs.length);
  ok(recs.every((x) => x.region && x.school && x.setting && x.class_name), 'no learner record is missing region, school, setting or class', recs);
  ok(recs.every((x) => /^P[0-9A-F]{12}$/.test(x.pseudo_id)) && new Set(recs.map((x) => x.pseudo_id)).size === 4, 'each enrolment has a unique pseudonymous ID');
  r = await tryAs('t1', 'select * from pilot_learner_records()');
  ok(r.err, 'only administrators can list all pilot learners');

  console.log('\n6. Teacher and learner views');
  r = await rpc1('t1', 'select pilot_my_classes()');
  ok(!r.err && r.v.length === 1 && r.v[0].learners.length === 2 && r.v[0].setting === 'rural' && r.v[0].region === 'Omusati',
    "teacher sees their class with region, setting and its learners", r.v);
  r = await rpc1('l1', 'select pilot_whoami()');
  ok(!r.err && r.v.class && r.v.class.setting === 'rural', 'learner sees which pilot class they are in', r.v);
  r = await rpc1('admin', 'select pilot_overview()');
  const om = !r.err && r.v.find((x) => x.region === 'Omusati');
  ok(om && om.schools === 2 && om.rural === 1 && om.urban === 1 && om.classes === 4 && om.teachers === 4 && om.learners === 4 && om.champion === 'Mr Champion',
    'administrator overview counts schools, classes, teachers and learners per region', om);
  const detail = await rpc1('champ', 'select pilot_region_detail(10::smallint)');
  const dj = JSON.stringify(detail.v);
  ok(!/Ndapewa|Tomas|Selma|Petrus|K12-NA/.test(dj), 'champion view shows learner counts, never learner names or IDs');

  console.log('\n7. Removing a learner');
  r = await rpc1('t1', 'select pilot_remove_learner($1::uuid, $2::uuid)', [C.tsandi11.id, U.l4]);
  r = await join('l4', C.outapi11.code);
  ok(!r.err, 'after removal the learner can join another class', r);

  console.log('\n8. Security: no back doors');
  r = await tryAs('l1', 'select * from enrolments');
  ok(!r.err && r.rows.length === 0, 'learners cannot read the enrolments table directly');
  r = await tryAs('t1', 'select * from classes');
  ok(!r.err && r.rows.length === 0, 'teachers cannot read the classes table directly');
  r = await tryAs('l1', "insert into enrolments (class_id, learner_id, joined_via) values ($1, $2, 'admin')", [C.outapi12.id, U.l1]);
  ok(r.err, 'nobody can write enrolments directly');
  r = await tryAs('l1', 'select pilot_enrol($1::uuid, $2::uuid, $3)', [C.outapi12.id, U.l1, 'admin']);
  ok(r.err && /permission denied/.test(r.err), 'the internal enrol function cannot be called through the API', r);
  r = await tryAs('l1', 'update profiles set champion_region_id = 10 where id = $1', [U.l1]);
  ok(r.err && /PROTECTED_FIELD/.test(r.err), 'a user cannot make themselves a champion');
  r = await tryAs('l1', 'update profiles set school_id = $2 where id = $1', [U.l1, S.whk]);
  ok(r.err && /PROTECTED_FIELD/.test(r.err), 'a learner still cannot change their own school directly');
  r = await tryAs('l1', "update profiles set role = 'admin' where id = $1", [U.l1]);
  ok(r.err && /PROTECTED_FIELD/.test(r.err), 'a user cannot make themselves an administrator');
  r = await tryAs('anon', 'select pilot_whoami()');
  ok(r.err && /permission denied/.test(r.err), 'signed-out visitors cannot call pilot functions');
  const newSignup = await (async () => {
    const id = (await db.query("insert into auth.users (email) values ('new@test.na') returning id")).rows[0].id;
    U.newL = id;
    return tryAs('newL', "insert into profiles (id, username, role, champion_region_id) values ($1, 'New', 'learner', 10)", [id]);
  })();
  const nl = (await db.query('select champion_region_id from profiles where id = $1', [U.newL])).rows[0];
  ok(!newSignup.err && nl && nl.champion_region_id === null, 'a new sign-up cannot give itself a champion region');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
