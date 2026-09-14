/* ---------------------------------------------------------------
   SKILLS MATRIX - which duties each employee is trained/signed off on.
   Drives the "suggest a cover" feature on the Duty Sheet (see
   modules/coverSuggestions.js). OPTIONAL: turning this module off only
   hides this screen - employee_skills data is untouched, and the
   auto-cover engine keeps reading whatever scores already exist.
   --------------------------------------------------------------- */
ModuleRegistry.register({
  id: 'skillsMatrix', name: 'Skills Matrix', core: false,
  hideSelectors: ['[data-buildertab="paneBuilderSkills"]', '#paneBuilderSkills'],
  description: 'Per-employee, per-duty proficiency scores (0-10), edited from the Duty Builder page\'s Skills Matrix tab. Existing scores keep powering Cover Suggestions even while this module is off; only the editing screen is hidden.'
});

function renderSkillsEmployeeList(){
  if (!ModuleRegistry.isEnabled('skillsMatrix')) return;
  const container = document.getElementById('skillsEmployeeList');
  if (!container) return;
  const search = (document.getElementById('skillsEmployeeSearch').value || '').toLowerCase();
  const employees = q("SELECT * FROM employees ORDER BY name COLLATE NOCASE").filter(e => e.name.toLowerCase().includes(search));
  const allDuties = q("SELECT * FROM duties ORDER BY group_label, name COLLATE NOCASE");
  container.innerHTML = employees.map(emp => {
    const scoreByDuty = new Map(q("SELECT duty_id, score FROM employee_skills WHERE employee_id=?", [emp.id]).map(r => [r.duty_id, r.score]));
    const checklist = allDuties.map(d => {
      const sub = [d.group_label, d.code].filter(Boolean).join(' \u00b7 ');
      const score = scoreByDuty.get(d.id) || 0;
      return `<label class="skill-check-row">
        <input type="number" class="skill-score-input" min="0" max="10" step="1" data-skill-emp="${emp.id}" data-skill-duty="${d.id}" value="${score}">
        <span class="skill-duty-name">${escapeHtml(d.name)}</span>${sub ? `<span class="skill-duty-sub">${escapeHtml(sub)}</span>` : ''}
      </label>`;
    }).join('');
    const skillCount = [...scoreByDuty.values()].filter(s => s > 0).length;
    return `<div class="leave-emp-row" data-emp-id="${emp.id}">
      <div class="leave-emp-head">
        <span class="leave-emp-name">${escapeHtml(emp.name)}</span>
        <span class="leave-count-badge ${skillCount ? 'has-leave' : ''}">${skillCount} skill${skillCount === 1 ? '' : 's'}</span>
        <button class="btn btn-sm" data-toggle-skills="${emp.id}">Show/hide</button>
      </div>
      <div class="skills-checklist" id="skillsList_${emp.id}">
        <p class="empty-hint" style="font-style:normal;margin-top:0;">0 = no skill. Scores rise automatically as they're assigned or cover a duty - the auto-cover engine prefers whoever's most experienced.</p>
        ${allDuties.length > 8 ? `<input type="text" class="skills-duty-filter" data-emp-id="${emp.id}" placeholder="Filter duties&hellip;">` : ''}
        <div class="skills-checklist-items">${checklist || '<p class="empty-hint">No duties added yet - add some on the Duty Builder page first.</p>'}</div>
      </div>
    </div>`;
  }).join('');
}

function wireSkillsPage(){
  document.getElementById('skillsEmployeeSearch').addEventListener('input', renderSkillsEmployeeList);
  document.getElementById('exportSkillsBtn').addEventListener('click', exportSkills);
  document.getElementById('importSkillsInput').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    await importSkillsFromFile(file);
    e.target.value = '';
  });

  document.addEventListener('click', e => {
    if (e.target.matches('[data-toggle-skills]')) {
      document.getElementById('skillsList_' + e.target.dataset.toggleSkills).classList.toggle('open');
    }
  });

  document.addEventListener('change', e => {
    if (e.target.matches('[data-skill-emp]')) {
      const empId = Number(e.target.dataset.skillEmp);
      const dutyId = Number(e.target.dataset.skillDuty);
      let score = Math.round(Number(e.target.value));
      if (isNaN(score) || score < 0) score = 0;
      if (score > 10) score = 10;
      e.target.value = score;
      if (score > 0) {
        run("INSERT INTO employee_skills (employee_id, duty_id, score) VALUES (?,?,?) ON CONFLICT(employee_id, duty_id) DO UPDATE SET score=excluded.score", [empId, dutyId, score]);
      } else {
        run("DELETE FROM employee_skills WHERE employee_id=? AND duty_id=?", [empId, dutyId]);
      }
      saveState();
      // Update just the badge, rather than a full re-render, so the open
      // checklist and scroll position aren't disturbed while editing scores.
      const row = document.querySelector(`#skillsEmployeeList .leave-emp-row[data-emp-id="${empId}"]`);
      if (row) {
        const count = q("SELECT COUNT(*) AS c FROM employee_skills WHERE employee_id=? AND score>0", [empId])[0].c;
        const badge = row.querySelector('.leave-count-badge');
        badge.textContent = count + ' skill' + (count === 1 ? '' : 's');
        badge.classList.toggle('has-leave', count > 0);
      }
    }
  });

  document.addEventListener('input', e => {
    if (e.target.matches('.skills-duty-filter')) {
      const empId = e.target.dataset.empId;
      const filterVal = e.target.value.toLowerCase();
      document.querySelectorAll(`#skillsList_${empId} .skill-check-row`).forEach(row => {
        row.style.display = row.textContent.toLowerCase().includes(filterVal) ? '' : 'none';
      });
    }
  });
}
