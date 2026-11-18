import { Role } from "microservices/auth-service/types";
import User from "models/user.model";
import { Types } from "mongoose";
import config from "config/env";
// Seed credentials come from SEED_* env vars — no hardcoded passwords.
export const defaultAdmin = (superAdminId:Types.ObjectId)=>{
    return {
        name: 'Admin',
        email: config.SEED_ADMIN_EMAIL as string,
        password: config.SEED_ADMIN_PASSWORD as string,
        role: Role.ADMIN,
        createdBy: superAdminId,
        updatedBy: superAdminId,
    }
}
export const defaultSuperAdmin = ()=>{
    return {
        name: 'Super Admin',
        email: config.SEED_SUPERADMIN_EMAIL as string,
        password: config.SEED_SUPERADMIN_PASSWORD as string,
        role: Role.SUPERADMIN,
    }
}

/**
 * Creates default super admin and admin users if they don't exist
 * @returns Promise that resolves with the super admin ID
 */
const createDefaultUsers = async (): Promise<string> => {
   return new Promise<string>(async (resolve, reject) => {
     try {
        if (!config.SEED_SUPERADMIN_EMAIL || !config.SEED_SUPERADMIN_PASSWORD) {
            console.warn("SEED_SUPERADMIN_EMAIL / SEED_SUPERADMIN_PASSWORD not set — skipping user seeding");
            return resolve("");
        }
        // Handle super admin
        const defaultSuperAdminData = defaultSuperAdmin();
        let superAdmin = await User.findOne({ role: Role.SUPERADMIN });

        if (superAdmin) {
            console.info("Super admin already exists, updating...");
            await superAdmin.set(defaultSuperAdminData).save();
        } else {
            console.info("Creating super admin...");
            superAdmin = await User.create(defaultSuperAdminData);
            console.info("Super admin created successfully");
        }

        if (!superAdmin) {
            throw new Error("Failed to create/update super admin");
        }

        if (!config.SEED_ADMIN_EMAIL || !config.SEED_ADMIN_PASSWORD) {
            return resolve(superAdmin._id.toString());
        }
        // Handle admin user
        let admin = await User.findOne({ 
            role: Role.ADMIN, 
            createdBy: superAdmin._id 
        });

        const adminData = defaultAdmin(superAdmin._id);
        
        if (admin) {
            console.info("Admin already exists, updating...");
            await admin.set(adminData).save();
        } else {
            console.info("Creating admin user...");
            admin = await User.create(adminData);
            console.info("Admin user created successfully");
        }
        resolve(superAdmin._id.toString())
     } catch (error) {
        console.error("Error in createDefaultUsers:", error);
        reject(error);
    }
   })
};


export { createDefaultUsers };
