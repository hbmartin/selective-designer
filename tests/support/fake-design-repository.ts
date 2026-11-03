import { Result } from '@bloodyowl/boxed';

import type { Design, DesignImage, DesignRepository } from '@/modules/design';

/** In-memory {@link DesignRepository} for use-case tests. */
export const createFakeDesignRepository = (now: () => Date) => {
  const designs = new Map<string, Design>();
  const images = new Map<string, DesignImage>();

  const repository: DesignRepository = {
    async list(query) {
      const items = [...designs.values()]
        .filter(
          (design) =>
            design.ownerId === query.ownerId &&
            (design.archivedAt !== null) === query.archived &&
            design.name.toLowerCase().includes(query.searchTerm.toLowerCase())
        )
        .slice(0, query.limit);
      return Result.Ok({
        type: 'design_listed',
        page: { items, nextCursor: undefined, total: items.length },
      });
    },
    async findOwned(input) {
      const design = designs.get(input.id);
      return Result.Ok(
        design && design.ownerId === input.ownerId
          ? { type: 'design_found', design }
          : { type: 'design_not_found' }
      );
    },
    async create(input) {
      const baseImage: DesignImage = {
        ...input.baseImage,
        designId: input.id,
        createdAt: now(),
      };
      const design: Design = {
        id: input.id,
        ownerId: input.ownerId,
        name: input.name,
        baseImage,
        copiedFromDesignId: input.copiedFromDesignId,
        archivedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      designs.set(design.id, design);
      images.set(baseImage.id, baseImage);
      return Result.Ok({ type: 'design_created', design });
    },
    async update(input) {
      const design = designs.get(input.id);
      if (!design || design.ownerId !== input.ownerId) {
        return Result.Ok({ type: 'design_not_found' });
      }
      const updated: Design = {
        ...design,
        ...(input.changes.name !== undefined
          ? { name: input.changes.name }
          : {}),
        ...(input.changes.archivedAt !== undefined
          ? { archivedAt: input.changes.archivedAt }
          : {}),
        updatedAt: now(),
      };
      designs.set(updated.id, updated);
      return Result.Ok({ type: 'design_updated', design: updated });
    },
    async findOwner(id) {
      const design = designs.get(id);
      return Result.Ok(
        design
          ? { type: 'design_owner', ownerId: design.ownerId }
          : { type: 'design_not_found' }
      );
    },
    async listImages(input) {
      return Result.Ok({
        type: 'images_listed',
        images: [...images.values()].filter(
          (image) =>
            image.designId === input.designId && image.kind === input.kind
        ),
      });
    },
    async findImage(imageId) {
      const image = images.get(imageId);
      const design = image ? designs.get(image.designId) : undefined;
      return Result.Ok(
        image && design
          ? {
              type: 'image_found',
              image,
              designName: design.name,
              ownerId: design.ownerId,
            }
          : { type: 'image_not_found' }
      );
    },
    async addImage(input) {
      const image: DesignImage = {
        ...input.image,
        designId: input.designId,
        createdAt: now(),
      };
      images.set(image.id, image);
      return Result.Ok({ type: 'image_added', image });
    },
  };

  return { repository, designs, images };
};
