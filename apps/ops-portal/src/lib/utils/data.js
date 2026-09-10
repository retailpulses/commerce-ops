import reposData from '../../data/repos.json';
import skillsData from '../../data/skills.json';
import domainsData from '../../data/domains.json';
import metaData from '../../data/meta.json';
import urlsData from '../../data/urls.json';

/** @type {Array<Record<string, any>>} */
export const repos = reposData;

/** @type {Array<Record<string, any>>} */
export const skills = skillsData;

/** @type {Array<Record<string, any>>} */
export const domains = domainsData;

/** @type {Record<string, any>} */
export const meta = metaData;

/** @type {Array<Record<string, any>>} */
export const urls = urlsData;

/**
 * @param {string} id
 * @returns {Record<string, any>|undefined}
 */
export function getDomain(id) {
  return domains.find((d) => d.id === id);
}

/**
 * @param {string} id
 * @returns {Record<string, any>|undefined}
 */
export function getRepo(id) {
  return repos.find((r) => r.id === id);
}

/**
 * @param {string} id
 * @returns {Record<string, any>|undefined}
 */
export function getSkill(id) {
  return skills.find((s) => s.id === id);
}

/**
 * @param {string} id
 * @returns {Record<string, any>|undefined}
 */
export function getUrlEntry(id) {
  return urls.find((entry) => entry.id === id);
}

/**
 * @param {string[]} repoIds
 * @returns {Array<Record<string, any>>}
 */
export function getReposByIds(repoIds) {
  return repos.filter((r) => repoIds.includes(r.id));
}

/**
 * @param {string[]} skillIds
 * @returns {Array<Record<string, any>>}
 */
export function getSkillsByIds(skillIds) {
  return skills.filter((s) => skillIds.includes(s.id));
}

/**
 * Get unique repo languages (non-empty).
 * @returns {string[]}
 */
export function getLanguages() {
  const langs = [...new Set(repos.map((r) => r.primaryLanguage).filter(Boolean))];
  return langs.sort();
}
