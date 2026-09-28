export function getHtmlInfiniteScrollScript(): string {
  return `
      class WeflowChunkStore {
        constructor(manifest, embeddedData) {
          this.manifest = manifest;
          this.embeddedData = Array.isArray(embeddedData) ? embeddedData : [];
          this.cache = new Map();
          this.loads = new Map();
          this.pending = new Map();
          this.maxCachedChunks = 8;

          window.__WEFLOW_CHUNK_LOADED__ = (chunkIndex, data) => {
            const index = Number(chunkIndex);
            const pending = this.pending.get(index);
            if (pending) {
              pending.resolve(Array.isArray(data) ? data : []);
            } else {
              this.remember(index, Array.isArray(data) ? data : []);
            }
          };
        }

        remember(index, data) {
          this.cache.delete(index);
          this.cache.set(index, data);
          while (this.cache.size > this.maxCachedChunks) {
            const oldest = this.cache.keys().next().value;
            this.cache.delete(oldest);
          }
          return data;
        }

        async load(index) {
          if (index < 0 || index >= this.manifest.chunks.length) return [];
          if (this.cache.has(index)) {
            return this.remember(index, this.cache.get(index));
          }
          if (!this.manifest.external) {
            return this.remember(index, index === 0 ? this.embeddedData : []);
          }
          if (this.loads.has(index)) return this.loads.get(index);

          const descriptor = this.manifest.chunks[index];
          const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const finish = (data) => {
              script.remove();
              this.pending.delete(index);
              this.loads.delete(index);
              resolve(this.remember(index, data));
            };
            const fail = () => {
              script.remove();
              this.pending.delete(index);
              this.loads.delete(index);
              reject(new Error('无法读取消息数据块 ' + (index + 1)));
            };
            this.pending.set(index, { resolve: finish, reject: fail });
            script.async = true;
            script.src = descriptor.u;
            script.onerror = fail;
            script.onload = () => {
              if (this.pending.has(index)) fail();
            };
            document.head.appendChild(script);
          });
          this.loads.set(index, promise);
          return promise;
        }
      }

      function findWeflowChunkByTime(descriptors, timestamp) {
        if (!descriptors.length) return -1;
        let low = 0;
        let high = descriptors.length - 1;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (descriptors[middle].max < timestamp) low = middle + 1;
          else high = middle;
        }
        return low;
      }

      function findWeflowChunkByGlobalIndex(descriptors, globalIndex) {
        let low = 0;
        let high = descriptors.length - 1;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          const descriptor = descriptors[middle];
          if (globalIndex < descriptor.s) high = middle - 1;
          else if (globalIndex >= descriptor.e) low = middle + 1;
          else return middle;
        }
        return -1;
      }

      function createWeflowGlobalSource(manifest, store) {
        return {
          total: manifest.total,
          chunkCount: manifest.chunks.length,
          descriptors: manifest.chunks,
          loadChunk: (index) => store.load(index),
          findChunkByTime: (timestamp) => findWeflowChunkByTime(manifest.chunks, timestamp)
        };
      }

      async function createWeflowSearchSource(globalSource, store, keyword, isCancelled, onProgress) {
        const normalizedKeyword = String(keyword || '').toLowerCase();
        const refs = [];
        for (let chunkIndex = 0; chunkIndex < globalSource.chunkCount; chunkIndex++) {
          if (isCancelled()) return null;
          const items = await store.load(chunkIndex);
          if (isCancelled()) return null;
          const descriptor = globalSource.descriptors[chunkIndex];
          for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
            if (String(items[itemIndex].b || '').toLowerCase().includes(normalizedKeyword)) {
              refs.push(descriptor.s + itemIndex);
            }
          }
          onProgress(chunkIndex + 1, globalSource.chunkCount, refs.length);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        const resultChunkSize = 500;
        const descriptors = [];
        for (let start = 0, index = 0; start < refs.length; start += resultChunkSize, index++) {
          const end = Math.min(start + resultChunkSize, refs.length);
          descriptors.push({ i: index, s: start, e: end, n: end - start, min: 0, max: 0 });
        }

        return {
          total: refs.length,
          chunkCount: descriptors.length,
          descriptors,
          loadChunk: async (resultChunkIndex) => {
            const start = resultChunkIndex * resultChunkSize;
            const end = Math.min(start + resultChunkSize, refs.length);
            const result = [];
            let sourceChunkIndex = -1;
            let sourceItems = [];
            for (let index = start; index < end; index++) {
              const globalIndex = refs[index];
              const nextSourceChunkIndex = findWeflowChunkByGlobalIndex(globalSource.descriptors, globalIndex);
              if (nextSourceChunkIndex !== sourceChunkIndex) {
                sourceChunkIndex = nextSourceChunkIndex;
                sourceItems = sourceChunkIndex >= 0 ? await store.load(sourceChunkIndex) : [];
              }
              if (sourceChunkIndex >= 0) {
                const sourceDescriptor = globalSource.descriptors[sourceChunkIndex];
                const item = sourceItems[globalIndex - sourceDescriptor.s];
                if (item) result.push(item);
              }
            }
            return result;
          }
        };
      }

      class BoundedInfiniteRenderer {
        constructor(container, renderItem, options) {
          this.container = container;
          this.renderItem = renderItem;
          this.options = options || {};
          this.source = null;
          this.sections = new Map();
          this.maxRenderedChunks = 3;
          this.generation = 0;
          this.pendingLoads = 0;
          this.lastScrollTop = 0;
          this.scrollFrame = 0;

          this.list = document.createElement('div');
          this.list.className = 'message-list';
          this.container.replaceChildren(this.list);
          this.container.addEventListener('scroll', () => this.scheduleScroll(), { passive: true });
        }

        setStatus(text, busy) {
          this.container.setAttribute('aria-busy', busy ? 'true' : 'false');
          if (this.options.onStatus) this.options.onStatus(text || '', busy === true);
        }

        sortedChunkIndexes() {
          return Array.from(this.sections.keys()).sort((a, b) => a - b);
        }

        async setSource(source, startChunkIndex, targetTimestamp) {
          const generation = ++this.generation;
          this.source = source;
          this.sections.clear();
          this.list.replaceChildren();
          this.container.scrollTop = 0;
          this.lastScrollTop = 0;

          if (!source || source.total === 0 || source.chunkCount === 0) {
            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '暂无消息';
            this.list.appendChild(empty);
            this.setStatus('', false);
            return;
          }

          const safeStart = Math.max(0, Math.min(Number(startChunkIndex) || 0, source.chunkCount - 1));
          this.setStatus('正在载入消息…', true);
          const section = await this.renderChunk(safeStart, 'append', generation);
          if (!section || generation !== this.generation) return;

          if (Number.isFinite(targetTimestamp)) {
            await this.focusTimestamp(safeStart, targetTimestamp, generation);
          }
          await this.fillViewport(generation);
          if (generation === this.generation) {
            this.setStatus('', false);
            this.reportRange();
          }
        }

        async renderChunk(chunkIndex, position, generation) {
          if (!this.source || generation !== this.generation) return null;
          if (chunkIndex < 0 || chunkIndex >= this.source.chunkCount) return null;
          if (this.sections.has(chunkIndex)) return this.sections.get(chunkIndex);

          this.pendingLoads++;
          try {
            const data = await this.source.loadChunk(chunkIndex);
            if (generation !== this.generation) return null;

            const section = document.createElement('section');
            section.className = 'message-chunk';
            section.dataset.chunkIndex = String(chunkIndex);
            section.setAttribute('aria-label', '消息区段 ' + (chunkIndex + 1));
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < data.length; index++) {
              const wrapper = document.createElement('div');
              wrapper.innerHTML = this.renderItem(data[index], index);
              if (wrapper.firstElementChild) fragment.appendChild(wrapper.firstElementChild);
            }
            section.appendChild(fragment);

            if (position === 'prepend' && this.list.firstChild) this.list.prepend(section);
            else this.list.appendChild(section);
            this.sections.set(chunkIndex, section);
            return section;
          } catch (error) {
            if (generation === this.generation) {
              this.setStatus(error && error.message ? error.message : '消息载入失败', false);
            }
            return null;
          } finally {
            this.pendingLoads = Math.max(0, this.pendingLoads - 1);
          }
        }

        async appendNext(generation) {
          if (!this.source || this.pendingLoads || generation !== this.generation) return;
          const indexes = this.sortedChunkIndexes();
          if (!indexes.length) return;
          const nextIndex = indexes[indexes.length - 1] + 1;
          if (nextIndex >= this.source.chunkCount) return;

          const section = await this.renderChunk(nextIndex, 'append', generation);
          if (!section || generation !== this.generation) return;
          while (this.sections.size > this.maxRenderedChunks) {
            const beforeHeight = this.list.scrollHeight;
            const beforeTop = this.container.scrollTop;
            const firstIndex = this.sortedChunkIndexes()[0];
            const firstSection = this.sections.get(firstIndex);
            if (!firstSection) break;
            firstSection.remove();
            this.sections.delete(firstIndex);
            const removedHeight = beforeHeight - this.list.scrollHeight;
            this.container.scrollTop = Math.max(0, beforeTop - removedHeight);
          }
          this.lastScrollTop = this.container.scrollTop;
          this.reportRange();
        }

        async prependPrevious(generation) {
          if (!this.source || this.pendingLoads || generation !== this.generation) return;
          const indexes = this.sortedChunkIndexes();
          if (!indexes.length) return;
          const previousIndex = indexes[0] - 1;
          if (previousIndex < 0) return;

          const beforeHeight = this.list.scrollHeight;
          const beforeTop = this.container.scrollTop;
          const section = await this.renderChunk(previousIndex, 'prepend', generation);
          if (!section || generation !== this.generation) return;
          this.container.scrollTop = beforeTop + (this.list.scrollHeight - beforeHeight);

          while (this.sections.size > this.maxRenderedChunks) {
            const lastIndex = this.sortedChunkIndexes().slice(-1)[0];
            const lastSection = this.sections.get(lastIndex);
            if (!lastSection) break;
            lastSection.remove();
            this.sections.delete(lastIndex);
          }
          this.lastScrollTop = this.container.scrollTop;
          this.reportRange();
        }

        async fillViewport(generation) {
          while (
            generation === this.generation &&
            this.sections.size < this.maxRenderedChunks &&
            this.list.scrollHeight < this.container.clientHeight + 600
          ) {
            const indexes = this.sortedChunkIndexes();
            if (!indexes.length) break;
            const maxIndex = indexes[indexes.length - 1];
            if (maxIndex + 1 < this.source.chunkCount) {
              await this.appendNext(generation);
            } else if (indexes[0] > 0) {
              await this.prependPrevious(generation);
            } else {
              break;
            }
          }
        }

        scheduleScroll() {
          if (this.scrollFrame) return;
          this.scrollFrame = requestAnimationFrame(() => {
            this.scrollFrame = 0;
            const currentTop = this.container.scrollTop;
            const direction = currentTop >= this.lastScrollTop ? 1 : -1;
            this.lastScrollTop = currentTop;
            const distanceToBottom = this.container.scrollHeight - currentTop - this.container.clientHeight;
            const generation = this.generation;
            if (direction < 0 && currentTop < 900) {
              void this.prependPrevious(generation);
            } else if (direction >= 0 && distanceToBottom < 1200) {
              void this.appendNext(generation);
            }
          });
        }

        async jumpToTime(timestamp) {
          if (!this.source || !this.source.findChunkByTime) return false;
          const chunkIndex = this.source.findChunkByTime(timestamp);
          if (chunkIndex < 0) return false;
          await this.setSource(this.source, chunkIndex, timestamp);
          return true;
        }

        async focusTimestamp(chunkIndex, timestamp, generation) {
          if (!this.source || generation !== this.generation) return;
          const data = await this.source.loadChunk(chunkIndex);
          if (generation !== this.generation || !data.length) return;

          let low = 0;
          let high = data.length - 1;
          while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (Number(data[middle].t) < timestamp) low = middle + 1;
            else high = middle;
          }
          const targetItem = data[low];
          const section = this.sections.get(chunkIndex);
          const element = section && section.querySelector('[data-index="' + targetItem.i + '"]');
          if (element) {
            element.scrollIntoView({ behavior: 'auto', block: 'center' });
            element.classList.add('highlight');
            setTimeout(() => element.classList.remove('highlight'), 2500);
            this.lastScrollTop = this.container.scrollTop;
          }
        }

        reportRange() {
          if (!this.options.onRange || !this.source) return;
          const indexes = this.sortedChunkIndexes();
          if (!indexes.length) return;
          const first = this.source.descriptors[indexes[0]];
          const last = this.source.descriptors[indexes[indexes.length - 1]];
          this.options.onRange(first.s, last.e, this.source.total);
        }
      }

      window.WeflowChunkStore = WeflowChunkStore;
      window.BoundedInfiniteRenderer = BoundedInfiniteRenderer;
      window.createWeflowGlobalSource = createWeflowGlobalSource;
      window.createWeflowSearchSource = createWeflowSearchSource;
    `
}
